export interface NextQuestionCase {
  id: string;
  category: string;
  previousQuestion: string;
  userAnswer: string;
  evaluationIntent: string;
}

export const NEXT_QUESTION_CASES: readonly NextQuestionCase[] = [
  {
    id: 'C01',
    category: 'multi-clue-selection',
    previousQuestion: '莒县一中住校那几年，有什么现在还记得特别清楚的？',
    userAnswer: '事情挺多。早上会去图书馆廊道背书，周末还得走路回家。有一次发大水，过沭河的时候水都到腰了。',
    evaluationIntent: '从多个线索中优先选择故事价值高的沭河危险经历。',
  },
  {
    id: 'C02',
    category: 'fact-to-meaning',
    previousQuestion: '后来第一次知道自己学的硅酸盐专业主要和水泥有关时，你是什么感觉？',
    userAnswer: '通知书下来我才知道硅酸盐主要和水泥有关，当时其实挺失落的。',
    evaluationIntent: '从事实进入情绪、认知变化或人生转折，不继续问百科事实。',
  },
  {
    id: 'C03',
    category: 'vague-answer-recovery',
    previousQuestion: '第一次升学落榜以后，后来为什么又去考莒县一中？',
    userAnswer: '当时也没想那么多，杨老师让我再试一次，我就去了。',
    evaluationIntent: '把简短平淡的回答继续追问成具体故事。',
  },
  {
    id: 'C04',
    category: 'leading-question-avoidance',
    previousQuestion: '王明晨老师平时对你们怎么样？',
    userAnswer: '他对学生挺好的。我们都是住校生，谁生病了或者心里有什么事，他一般都会注意到。',
    evaluationIntent: '追问具体事件，不自行添加像父亲一样等情感结论。',
  },
  {
    id: 'C05',
    category: 'known-score-deduplication',
    previousQuestion: '你觉得自己当年高考发挥得怎么样？',
    userAnswer: '那年成绩还可以，化学应该算考得最好。',
    evaluationIntent: '已有分数证据时避免再问具体分数，转而追偏科对志愿选择的影响。',
  },
  {
    id: 'C06',
    category: 'date-conflict',
    previousQuestion: '你还记得正式高考是什么时候吗？',
    userAnswer: '好像是7月7号吧，时间太久了，我也不敢确定。',
    evaluationIntent: '用历史证据自然核对1983年正式高考日期，不盲目接受或生硬纠正。',
  },
  {
    id: 'C07',
    category: 'known-story-deepening',
    previousQuestion: '从莒县一中周末回家的路上，有没有发生过危险的事情？',
    userAnswer: '有一次过沭河确实挺危险的。',
    evaluationIntent: '已有过河过程细节时继续追心理、判断、危险感或后续影响，不重复问怎么过河。',
  },
  {
    id: 'C08',
    category: 'unknown-teacher-motivation',
    previousQuestion: '第一次升学没成功以后发生了什么？',
    userAnswer: '后来是杨老师让我再去试一次，我才去考了莒县一中。',
    evaluationIntent: '在已知推荐、考试、录取事实后追问推荐原因、老师原话或用户为何再试。',
  },
  {
    id: 'C09',
    category: 'rural-expectation-era',
    previousQuestion: '那时候你是不是从一开始就认定一定要考大学？',
    userAnswer: '没有。我们农村孩子消息很闭塞，很多人觉得高中毕业以后就是回家种地。我爸连房子都已经给我盖好了。',
    evaluationIntent: 'Era 帮助发现时代环境与个人命运的交叉点，不输出历史讲解。',
  },
  {
    id: 'C10',
    category: 'era-change',
    previousQuestion: '你感觉那个年代大家对高考的看法有没有发生变化？',
    userAnswer: '后来学校里慢慢越来越重视高考了，但我们农村孩子知道外面的事情还是很少。',
    evaluationIntent: 'Era 帮助提出有时代纵深的问题，不直接输出历史背景。',
  },
];
