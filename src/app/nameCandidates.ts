const MAX_CANDIDATES = 10;
const MAX_NAME_LENGTH = 40;

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function parseParticipantNameCandidates(
  input: string,
): readonly string[] {
  const hasExplicitDelimiter = /[,\n\r]/u.test(input);
  const segments = hasExplicitDelimiter
    ? input.split(/[,\n\r]+/u)
    : input.split(/\s+/u);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const name = normalizeName(segment);
    if (!name || [...name].length > MAX_NAME_LENGTH || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length === MAX_CANDIDATES) break;
  }
  return Object.freeze(names);
}
