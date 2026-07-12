-- Migration corrective : application "exactement une fois" des résultats de manche.
-- À coller dans Supabase → SQL Editor → New query → Run, sur un projet où schema.sql (et
-- éventuellement migration_mosaic.sql) a déjà été exécuté. Rejouable sans risque.
--
-- Contexte : avec l'ancien apply_round_results, un client résolveur lent (réseau) pouvait réécrire
-- les joueurs APRÈS qu'un autre client (via force_unclaim_stuck_round) avait déjà appliqué la même
-- manche, ajoutant une entrée round_history en double. L'avancement de manche sert maintenant de
-- garde, exécuté en premier dans la même transaction.

create or replace function apply_round_results(p_game_id uuid, p_round int, p_results jsonb)
returns void language plpgsql as $$
declare
  v_ok boolean;
begin
  update games set phase = 'playing', current_round = p_round + 1, resolving_since = null
  where id = p_game_id and phase = 'resolving' and current_round = p_round
  returning true into v_ok;
  if not coalesce(v_ok, false) then
    return;
  end if;

  update players p set
    wall                    = r.wall,
    pattern_lines           = r.pattern_lines,
    floor_filled            = r.floor_filled,
    has_first_player_marker = false,
    total_score             = r.total_score,
    round_history           = p.round_history || r.round_history_entry,
    ready                   = false,
    pending_column_choices  = '{}'::jsonb,
    updated_at              = now()
  from jsonb_to_recordset(p_results)
    as r(id uuid, wall jsonb, pattern_lines jsonb, floor_filled int, total_score int, round_history_entry jsonb)
  where p.id = r.id and p.game_id = p_game_id;
end;
$$;
