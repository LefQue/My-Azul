// Plomberie Supabase partagée par host.html / join.html / player.html / spectator.html.
// Nécessite : vendor/supabase-js.min.js puis shared/supabase-config.js chargés avant ce fichier.

const azulSupabase = window.supabase.createClient(window.AZUL_SUPABASE_URL, window.AZUL_SUPABASE_ANON_KEY);

function randomJoinCode(){
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // évite les caractères ambigus (0/O, 1/I/L)
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

// crypto.randomUUID() n'existe que dans un contexte sécurisé (HTTPS ou localhost) — indisponible
// en HTTP simple sur une IP locale (utilisé pendant les tests avant déploiement Vercel/HTTPS), d'où
// ce repli qui ne dépend d'aucune API restreinte au contexte sécurisé.
function randomId(){
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function getOrCreateDeviceId(){
  let id = localStorage.getItem('azulMpDeviceId');
  if (!id){
    id = randomId();
    localStorage.setItem('azulMpDeviceId', id);
  }
  return id;
}

async function createGame(maxPlayers){
  const joinCode = randomJoinCode();
  const { data: game, error } = await azulSupabase.from('games')
    .insert({ join_code: joinCode, max_players: maxPlayers })
    .select().single();
  if (error) throw error;

  const seats = Array.from({ length: maxPlayers }, (_, i) => ({ game_id: game.id, slot_index: i }));
  const { error: playersError } = await azulSupabase.from('players').insert(seats);
  if (playersError) throw playersError;

  return game;
}

async function fetchGameByJoinCode(joinCode){
  const { data, error } = await azulSupabase.from('games')
    .select('*').eq('join_code', joinCode.toUpperCase()).maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchGameById(gameId){
  const { data, error } = await azulSupabase.from('games').select('*').eq('id', gameId).single();
  if (error) throw error;
  return data;
}

async function fetchPlayers(gameId){
  const { data, error } = await azulSupabase.from('players')
    .select('*').eq('game_id', gameId).order('slot_index');
  if (error) throw error;
  return data;
}

// Réclame un siège vide ; renvoie le joueur si réussi, null si le siège vient d'être pris par quelqu'un d'autre.
async function claimSlot(playerId, name, deviceId){
  const { data, error } = await azulSupabase.from('players')
    .update({ name, claimed_by_device_id: deviceId })
    .eq('id', playerId)
    .is('claimed_by_device_id', null)
    .select();
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

function subscribeToGame(gameId, { onGameChange, onPlayerChange }){
  const channel = azulSupabase.channel(`game-${gameId}`)
    .on('postgres_changes', { event:'*', schema:'public', table:'games', filter:`id=eq.${gameId}` },
        payload => onGameChange && onGameChange(payload.new))
    .on('postgres_changes', { event:'*', schema:'public', table:'players', filter:`game_id=eq.${gameId}` },
        payload => onPlayerChange && onPlayerChange(payload.eventType, payload.new || payload.old))
    .subscribe();
  return () => azulSupabase.removeChannel(channel);
}

// ---- conversion entre la forme "ligne Supabase" (snake_case) et la forme "player" legacy (camelCase,
// celle attendue par scoring-engine.js) ----

function toLegacyPlayerShape(row){
  return {
    name: row.name,
    wall: row.wall,
    patternLines: row.pattern_lines,
    floorFilled: row.floor_filled,
    hasFirstPlayerMarker: row.has_first_player_marker,
    totalScore: row.total_score,
    roundHistory: row.round_history,
    finalBonuses: row.final_bonuses,
  };
}

function fromLegacyPlayerShape(id, player){
  return {
    id,
    wall: player.wall,
    pattern_lines: player.patternLines,
    floor_filled: player.floorFilled,
    total_score: player.totalScore,
    round_history_entry: player.roundHistory[player.roundHistory.length - 1],
  };
}

async function toggleReady(gameId, playerId, ready, round){
  const { error: updateError } = await azulSupabase.from('players').update({ ready }).eq('id', playerId);
  if (updateError) throw updateError;
  if (!ready) return;
  const { data: claimed, error } = await azulSupabase.rpc('try_claim_round_resolution', {
    p_game_id: gameId, p_round: round,
  });
  if (error) throw error;
  if (claimed) await resolveRoundAndWriteResults(gameId, round);
}

async function resolveRoundAndWriteResults(gameId, round){
  const rows = await fetchPlayers(gameId);
  const results = rows.map(row => {
    const player = toLegacyPlayerShape(row);
    endRoundForPlayer(player, round); // scoring-engine.js, réutilisé tel quel
    return fromLegacyPlayerShape(row.id, player);
  });
  const { error } = await azulSupabase.rpc('apply_round_results', {
    p_game_id: gameId, p_round: round, p_results: results,
  });
  if (error) throw error;
}

async function forceUnclaimStuckRound(gameId, round){
  await azulSupabase.rpc('force_unclaim_stuck_round', { p_game_id: gameId, p_round: round });
}

async function endGame(gameId){
  const rows = await fetchPlayers(gameId);
  for (const row of rows){
    const player = toLegacyPlayerShape(row);
    computeEndGameBonuses(player); // scoring-engine.js, réutilisé tel quel
    await azulSupabase.from('players').update({
      total_score: player.totalScore,
      final_bonuses: player.finalBonuses,
    }).eq('id', row.id);
  }
  await azulSupabase.from('games').update({ phase: 'ended' }).eq('id', gameId);
}
