// Converts a raw UVS/Spicerack match (from getRoundMatches) into a
// CanonicalMatch — the source-agnostic shape the rating engine consumes.
// Swap THIS file to support another data source; the engine never changes.
//
// PRIVACY (enforced here, by design): the raw API exposes players' EMAIL and
// FULL NAME. We deliberately keep ONLY the stable player id + the public
// handle (`best_identifier`). Email / first_name / last_name are dropped on the
// floor and never leave this function. Data minimization = fewer GDPR risks.
//
// Raw match shape (verified):
// {
//   id, table_number, status, match_is_bye, match_is_loss,
//   match_is_intentional_draw, match_is_unintentional_draw, games_drawn,
//   winning_player: <player.id>, games_won_by_winner, games_won_by_loser,
//   players: [ { player_order, games_won,
//                player: { id, best_identifier, email, first_name } }, ... ]
// }

/**
 * @returns {null | CanonicalMatch}  null = skip (not a usable 1v1 result)
 *
 * CanonicalMatch = {
 *   source, eventId, roundId, roundNumber, date, table, matchId,
 *   isBye: boolean,
 *   playerA: { id, name } | null,
 *   playerB: { id, name } | null,
 *   winner: 'A' | 'B' | 'draw' | null
 * }
 */
export function matchToCanonical(match, ctx) {
  const players = match?.players || [];

  // Bye: a single participant (or flagged). Recorded but excluded from rating.
  if (match?.match_is_bye || players.length === 1) {
    return { ...base(match, ctx), isBye: true, playerA: toPlayer(players[0]), playerB: null, winner: null };
  }
  // 1v1 only — skip multiplayer pods.
  if (players.length !== 2) return null;
  // Skip unfinished matches.
  if (match.status && String(match.status).toUpperCase() !== "COMPLETE") return null;

  const ordered = [...players].sort((a, b) => (a.player_order ?? 0) - (b.player_order ?? 0));
  const [a, b] = ordered;
  const aId = a?.player?.id;
  const bId = b?.player?.id;

  let winner;
  if (match.match_is_intentional_draw || match.match_is_unintentional_draw) {
    winner = "draw";
  } else if (match.winning_player != null) {
    if (match.winning_player === aId) winner = "A";
    else if (match.winning_player === bId) winner = "B";
    else return null; // winner not among the two known players — bail
  } else if ((match.games_drawn ?? 0) > 0 && (a.games_won ?? 0) === (b.games_won ?? 0)) {
    winner = "draw";
  } else {
    return null; // undetermined
  }

  return {
    ...base(match, ctx),
    isBye: false,
    playerA: toPlayer(a),
    playerB: toPlayer(b),
    winner,
  };
}

function toPlayer(entry) {
  const p = entry?.player || {};
  // ONLY id + public handle. Email / real name intentionally discarded.
  return {
    id: p.id != null ? String(p.id) : null,
    name: p.best_identifier || p.user_identifier || "Unknown",
  };
}

function base(match, ctx) {
  return {
    source: "uvsgames",
    eventId: ctx.eventId,
    roundId: ctx.roundId,
    roundNumber: ctx.roundNumber ?? null,
    date: ctx.date || null,
    table: match.table_number ?? null,
    matchId: match.id,
  };
}
