import type { CoachGateResult, CoachPacket, CoachScenario } from './types.js';

const MAX_PACKET_CHARS = 160;

function clip(value: string, maxChars: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= maxChars ? chars.join('') : chars.slice(0, maxChars).join('');
}

function knownText(packet: CoachPacket | undefined, currentAnswer: string): string {
  const known = packet?.known.filter(Boolean).join('；');
  return clip(known || currentAnswer || '当前回答', 52);
}

function gapFor(scenario: CoachScenario, reason: CoachGateResult['reason']): string {
  if (scenario === 'onboarding') {
    return reason === 'direction_drift' ? '人生时间线仍有阶段未覆盖' : '当前人生阶段还未覆盖';
  }
  if (reason === 'repeated_question') return '这个问题已经问过';
  if (reason === 'direction_drift' || reason === 'scenario_boundary') return '采访需回到当前故事';
  return '一个关键细节还未说清';
}

export function renderMiniCoachPacket(input: {
  scenario: CoachScenario;
  currentUserAnswer: string;
  gate: CoachGateResult;
  packet?: CoachPacket;
  scenarioState?: Record<string, unknown>;
}): string {
  const { scenario, currentUserAnswer, gate, packet } = input;
  if (gate.action === 'none' || !gate.direction) return '';

  let lines: string[];
  if (scenario === 'onboarding' || scenario === 'story_create') {
    lines = [
      `【采访教练】已知：${knownText(packet, currentUserAnswer)}`,
      `缺口：${gapFor(scenario, gate.reason)}`,
      `方向：${clip(packet?.direction || gate.direction, 80)}`,
    ];
  } else if (scenario === 'story_continue') {
    lines = [
      `【采访教练】已知：${knownText(packet, currentUserAnswer)}`,
      ...(packet?.avoid || gate.avoid ? [`避免：${clip(packet?.avoid || gate.avoid || '', 44)}`] : []),
      ...(packet?.conflict ? [`冲突：${clip(packet.conflict, 44)}`] : []),
      `方向：${clip(packet?.direction || gate.direction, 64)}`,
    ];
  } else {
    const contributorSummary = typeof input.scenarioState?.contributor_summary === 'string'
      ? input.scenarioState.contributor_summary
      : '';
    lines = [
      `【采访教练】已有：${knownText(packet, contributorSummary || currentUserAnswer)}`,
      `注意：${clip(packet?.avoid || gate.avoid || '只确认她自己的亲历记忆，不替主人公确认事实', 48)}`,
      `方向：${clip(packet?.direction || gate.direction, 64)}`,
    ];
  }

  const rendered = lines.join('\n');
  return clip(rendered, MAX_PACKET_CHARS);
}
