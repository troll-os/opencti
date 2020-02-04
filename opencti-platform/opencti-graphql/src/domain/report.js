import { assoc, append, propOr, pipe } from 'ramda';
import {
  createEntity,
  distributionEntities,
  escapeString,
  getSingleValueNumber,
  listEntities,
  listRelations,
  loadEntityById,
  loadEntityByStixId,
  prepareDate,
  timeSeriesEntities
} from '../database/grakn';
import { BUS_TOPICS } from '../config/conf';
import { REL_INDEX_PREFIX } from '../database/elasticSearch';
import { notify } from '../database/redis';
import { findAll as findAllStixObservables } from './stixObservable';
import { findAll as findAllStixDomainEntities } from './stixDomainEntity';
import { findById as findIdentityById } from './identity';

export const STATUS_STATUS_NEW = 0;
export const STATUS_STATUS_PROGRESS = 1;
export const STATUS_STATUS_ANALYZED = 2;
export const STATUS_STATUS_CLOSED = 3;

export const findById = reportId => {
  if (reportId.match(/[a-z-]+--[\w-]{36}/g)) {
    return loadEntityByStixId(reportId);
  }
  return loadEntityById(reportId);
};
export const findAll = async args => {
  return listEntities(['Report'], ['name', 'description'], args);
};

// Entities tab
export const objectRefs = (reportId, args) => {
  const finalArgs = assoc(
    'filters',
    append({ key: `${REL_INDEX_PREFIX}object_refs.internal_id_key`, values: [reportId] }, propOr([], 'filters', args)),
    args
  );
  return findAllStixDomainEntities(finalArgs);
};
// Relation refs
export const relationRefs = (reportId, args) => {
  const pointingFilter = { relation: 'object_refs', fromRole: 'so', toRole: 'knowledge_aggregation', id: reportId };
  return listRelations(args.relationType, pointingFilter, args);
};
// Observable refs
export const observableRefs = (reportId, args) => {
  const finalArgs = assoc(
    'filters',
    append(
      { key: `${REL_INDEX_PREFIX}observable_refs.internal_id_key`, values: [reportId] },
      propOr([], 'filters', args)
    ),
    args
  );
  return findAllStixObservables(finalArgs);
};

// region series
export const reportsTimeSeries = args => {
  const { reportClass } = args;
  const filters = reportClass ? [{ isRelation: false, type: 'report_class', value: args.reportClass }] : [];
  return timeSeriesEntities('Incident', filters, args);
};
export const reportsNumber = args => ({
  count: getSingleValueNumber(`match $x isa Report;
   ${args.reportClass ? `; $x has report_class "${escapeString(args.reportClass)}"` : ''} 
   ${args.endDate ? `$x has created_at $date; $date < ${prepareDate(args.endDate)};` : ''}
   get; count;`),
  total: getSingleValueNumber(`match $x isa Report;
    ${args.reportClass ? `; $x has report_class "${escapeString(args.reportClass)}"` : ''}
    get; count;`)
});
export const reportsTimeSeriesByEntity = args => {
  const filters = [{ isRelation: true, type: 'object_refs', value: args.objectId }];
  return timeSeriesEntities('Report', filters, args);
};
export const reportsTimeSeriesByAuthor = async args => {
  const { authorId, reportClass } = args;
  const filters = [{ isRelation: true, from: 'so', to: 'creator', type: 'created_by_ref', value: authorId }];
  if (reportClass) filters.push({ isRelation: false, type: 'report_class', value: reportClass });
  return timeSeriesEntities('Report', filters, args);
};
export const reportsNumberByEntity = args => ({
  count: getSingleValueNumber(
    `match $x isa Report;
    $rel(knowledge_aggregation:$x, so:$so) isa object_refs; 
    $so has internal_id_key "${escapeString(args.objectId)}" ${
      args.reportClass
        ? `; 
    $x has report_class "${escapeString(args.reportClass)}"`
        : ''
    } ${
      args.endDate
        ? `; 
    $x has created_at $date;
    $date < ${prepareDate(args.endDate)};`
        : ''
    }
    get;
    count;`
  ),
  total: getSingleValueNumber(
    `match $x isa Report;
    $rel(knowledge_aggregation:$x, so:$so) isa object_refs; 
    $so has internal_id_key "${escapeString(args.objectId)}" ${
      args.reportClass
        ? `; 
    $x has report_class "${escapeString(args.reportClass)}"`
        : ';'
    }
    get;
    count;`
  )
});
export const reportsDistributionByEntity = async args => {
  const { objectId } = args;
  const filters = [{ isRelation: true, from: 'knowledge_aggregation', to: 'so', type: 'object_refs', value: objectId }];
  return distributionEntities('Report', filters, args);
};
// endregion

// region mutations
export const addReport = async (user, report) => {
  // Get the reliability of the author
  let sourceConfidenceLevel = 1;
  if (report.createdByRef) {
    const identity = await findIdentityById(report.createdByRef);
    if (identity.reliability) {
      switch (identity.reliability) {
        case 'A':
          sourceConfidenceLevel = 4;
          break;
        case 'B':
          sourceConfidenceLevel = 3;
          break;
        case 'C':
          sourceConfidenceLevel = 2;
          break;
        default:
          sourceConfidenceLevel = 1;
      }
    }
  }
  const finalReport = pipe(
    assoc('object_status', propOr(STATUS_STATUS_NEW, 'object_status', report)),
    assoc('source_confidence_level', propOr(sourceConfidenceLevel, 'source_confidence_level', report))
  )(report);
  const created = await createEntity(finalReport, 'Report');
  return notify(BUS_TOPICS.StixDomainEntity.ADDED_TOPIC, created, user);
};
// endregion
