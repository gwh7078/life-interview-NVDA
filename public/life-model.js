function finiteYear(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    ? value
    : null;
}

function stableStageOrder(left, right) {
  const leftOrder = typeof left.stage.sort_order === 'number' && Number.isFinite(left.stage.sort_order)
    ? left.stage.sort_order
    : Number.POSITIVE_INFINITY;
  const rightOrder = typeof right.stage.sort_order === 'number' && Number.isFinite(right.stage.sort_order)
    ? right.stage.sort_order
    : Number.POSITIVE_INFINITY;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;

  const leftCreatedAt = typeof left.stage.created_at === 'string' ? left.stage.created_at : '';
  const rightCreatedAt = typeof right.stage.created_at === 'string' ? right.stage.created_at : '';
  const createdAtOrder = leftCreatedAt.localeCompare(rightCreatedAt);
  return createdAtOrder || left.index - right.index;
}

/**
 * Sort Life Stages for the read-only timeline presentation. This does not
 * assign or persist sort_order values.
 */
export function sortLifeStages(stages) {
  return stages
    .map((stage, index) => ({ stage, index }))
    .sort((left, right) => {
      const leftStage = left.stage;
      const rightStage = right.stage;
      const leftCurrent = leftStage.end_year === 'now';
      const rightCurrent = rightStage.end_year === 'now';

      if (leftCurrent !== rightCurrent) return leftCurrent ? 1 : -1;

      const leftStartYear = finiteYear(leftStage.start_year);
      const rightStartYear = finiteYear(rightStage.start_year);

      if (leftCurrent) {
        if (leftStartYear === null && rightStartYear !== null) return 1;
        if (leftStartYear !== null && rightStartYear === null) return -1;
        if (leftStartYear !== null && rightStartYear !== null && leftStartYear !== rightStartYear) {
          return leftStartYear - rightStartYear;
        }
        return stableStageOrder(left, right);
      }

      if (leftStartYear === null && rightStartYear !== null) return 1;
      if (leftStartYear !== null && rightStartYear === null) return -1;
      if (leftStartYear !== null && rightStartYear !== null && leftStartYear !== rightStartYear) {
        return leftStartYear - rightStartYear;
      }
      return stableStageOrder(left, right);
    })
    .map(({ stage }) => stage);
}

/** Format the product's open year range, keeping unknown distinct from now. */
export function formatLifeStageYears(stage) {
  const startYear = finiteYear(stage.start_year);
  const endYear = finiteYear(stage.end_year);

  if (startYear === null && stage.end_year === null) return '年份未填写';
  if (stage.end_year === 'now') return `${startYear ?? ''}–至今`;
  if (startYear === null) return `–${endYear ?? ''}`;
  return `${startYear}–${endYear ?? ''}`;
}
