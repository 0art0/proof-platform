import type { DisplayedSuggestionSet } from "@proof/protocol";

type Suggestion = DisplayedSuggestionSet["suggestions"][number];

const DIRECTION_WORDS: Readonly<Record<string, string>> = {
  forward: "forward direction",
  backward: "backward direction",
};

/** "pattern:and-commutativity-backward" without what every candidate shares becomes "backward". */
function distinguishingTails(identifiers: readonly string[]): readonly string[] {
  const parts = identifiers.map((identifier) => identifier.replace(/^[a-z]+:/, "").split(/[-_:]/));
  let shared = 0;
  const first = parts[0] ?? [];
  while (
    shared < first.length &&
    parts.every((words) => words[shared] !== undefined && words[shared] === first[shared])
  ) {
    shared += 1;
  }
  return parts.map((words) => words.slice(shared).join(" "));
}

function wording(tail: string): string {
  return DIRECTION_WORDS[tail] ?? tail;
}

/**
 * A short phrase for each suggestion whose name another displayed suggestion shares, so two cards
 * called "Commutativity of conjunction" can be told apart (the direction the result is used in,
 * else what differs in its pattern, result or instantiation). Members of one stored variant
 * family are meant to look alike and get no qualifier. Pure: it reads only the stored set.
 */
export function suggestionQualifiers(
  suggestions: readonly Suggestion[],
): ReadonlyMap<string, string> {
  const byName = new Map<string, Suggestion[]>();
  for (const suggestion of suggestions) {
    byName.set(suggestion.name, [...(byName.get(suggestion.name) ?? []), suggestion]);
  }
  const qualifiers = new Map<string, string>();
  for (const members of byName.values()) {
    if (members.length < 2) continue;
    const family = members[0]?.variantFamilyId;
    if (
      family !== undefined &&
      members.every(({ variantFamilyId }) => variantFamilyId === family)
    ) {
      continue;
    }
    const candidates: (readonly string[])[] = [
      distinguishingTails(members.map(({ patternId }) => patternId)).map(wording),
      distinguishingTails(members.map(({ artifactId }) => artifactId)),
      members.map(({ substitutions }) =>
        substitutions
          .map(({ symbol, expression }) => `${symbol} = ${JSON.stringify(expression)}`)
          .join(", "),
      ),
    ];
    const distinct = candidates.find(
      (tails) => tails.every((tail) => tail.length > 0) && new Set(tails).size === members.length,
    );
    members.forEach((member, index) => {
      qualifiers.set(member.id, distinct?.[index] ?? `option ${index + 1}`);
    });
  }
  return qualifiers;
}
