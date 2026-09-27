export const EXTERNAL_CONTRIBUTOR_RELATIONSHIP_LABELS: Record<string, string> = {
  wife: '妻子',
  husband: '丈夫',
  daughter: '女儿',
  son: '儿子',
  father: '父亲',
  mother: '母亲',
  sibling: '兄弟姐妹',
  friend: '朋友',
  classmate: '同学',
  colleague: '同事',
  other: '亲友',
};

export function externalContributorRelationshipLabel(value: string): string {
  return EXTERNAL_CONTRIBUTOR_RELATIONSHIP_LABELS[value] ?? '亲友';
}
