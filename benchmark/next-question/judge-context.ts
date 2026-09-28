import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KNOWN_FACT_MATCHERS: Record<string, readonly RegExp[]> = {
  C01: [/沭河/u, /漫过桥面/u, /没过腰/u, /相互搀扶/u, /行李举过头顶/u],
  C02: [/硅酸盐/u, /水泥/u, /失落/u],
  C03: [/杨立苗/u, /推荐.*莒县一中/u, /再试一次/u],
  C04: [/王明晨/u, /发烧/u, /输液/u],
  C05: [/486分/u, /450分/u, /99\.5分/u, /语文58分/u],
  C06: [/正式高考/u, /7月15日/u, /往年是7月7日/u],
  C07: [/沭河/u, /没过腰/u, /相互搀扶/u, /行李举过头顶/u],
  C08: [/杨立苗/u, /莒县一中/u, /推荐/u, /录取/u],
  C09: [/农村孩子/u, /回家务农/u, /盖好了房子/u],
  C10: [/高考/u, /农村孩子/u, /外面的事情/u],
};

interface TranscriptMessage {
  role?: string;
  text?: string;
}

interface EraRecord {
  start_year: number;
  end_year: number;
  category: string;
  title: string;
  summary: string;
}

function loadSharedEraContext(): string {
  const path = fileURLToPath(new URL('../../data/era-context/era-context.zh-CN.jsonl', import.meta.url));
  const records = readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as EraRecord);
  const record = records.find((item) => item.category === '教育'
    && item.title.startsWith('恢复高考改变教育记忆：家庭生活')
    && item.start_year <= 1978 && item.end_year >= 1978);
  if (!record) throw new Error('JUDGE_SHARED_ERA_CONTEXT_UNAVAILABLE');
  return `${record.start_year}-${record.end_year} 年背景：${record.summary}（一般时代背景，不代表个人经历或态度。）`;
}

export function loadJudgeContext(input: {
  databasePath: string;
  ownerId: string;
  storyId: string;
  storySummary: string;
  agentMemory: string;
  lifeStageTitle: string;
  lifeStageStartDate: string | null;
  lifeStageEndDate: string | null;
}): Record<string, { known_context: Record<string, unknown>; historical_known_facts: string[] }> {
  const database = new Database(input.databasePath, { readonly: true, fileMustExist: true });
  let transcripts: TranscriptMessage[] = [];
  try {
    const rows = database.prepare(`
      SELECT transcript_json
      FROM interview_sessions
      WHERE user_id = ? AND story_id = ? AND status = 'completed'
      ORDER BY ended_at, session_id
    `).all(input.ownerId, input.storyId) as Array<{ transcript_json: string }>;
    transcripts = rows.flatMap((row) => JSON.parse(row.transcript_json) as TranscriptMessage[]);
  } finally {
    database.close();
  }

  const personalFacts = transcripts
    .filter((message) => message.role === 'user' && typeof message.text === 'string')
    .map((message) => message.text!.trim())
    .filter(Boolean);
  const eraContext = loadSharedEraContext();
  return Object.fromEntries(Object.entries(KNOWN_FACT_MATCHERS).map(([caseId, matchers]) => {
    const selected: string[] = [];
    for (const matcher of matchers) {
      const fact = personalFacts.find((text) => matcher.test(text));
      if (fact && !selected.includes(fact)) selected.push(fact);
    }
    if ((caseId === 'C05' || caseId === 'C06' || caseId === 'C07' || caseId === 'C08') && selected.length === 0) {
      throw new Error(`JUDGE_HISTORICAL_FACTS_UNAVAILABLE_${caseId}`);
    }
    const historicalKnownFacts = caseId === 'C09' || caseId === 'C10' ? [...selected, eraContext] : selected;
    return [caseId, {
      known_context: {
        life_stage: {
          title: input.lifeStageTitle,
          start_date: input.lifeStageStartDate,
          end_date: input.lifeStageEndDate,
        },
        story_summary: input.storySummary,
        agent_memory: input.agentMemory,
      },
      historical_known_facts: historicalKnownFacts,
    }];
  }));
}
