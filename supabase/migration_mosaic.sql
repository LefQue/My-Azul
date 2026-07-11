-- Migration additive pour la Mosaïque éclatante en multijoueur.
-- À coller dans Supabase → SQL Editor → New query → Run, UNE SEULE FOIS sur un projet où
-- supabase/schema.sql a déjà été exécuté (crée les colonnes/contraintes manquantes sans toucher
-- aux parties déjà en cours ; rejouable sans risque si on l'exécute deux fois par erreur).

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'games' and column_name = 'game_mode'
  ) then
    alter table games add column game_mode text not null default 'base';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'games_game_mode_check'
  ) then
    alter table games add constraint games_game_mode_check
      check (game_mode in ('base','mosaic_free','mosaic_a','mosaic_b'));
  end if;
end $$;

alter table players add column if not exists pending_column_choices jsonb not null default '{}'::jsonb;

-- apply_round_results doit aussi remettre pending_column_choices à zéro après chaque manche
-- (comme ready), sinon un choix de colonne de la manche N-1 pourrait fuiter en manche N.
create or replace function apply_round_results(p_game_id uuid, p_round int, p_results jsonb)
returns void language plpgsql as $$
begin
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

  update games set phase = 'playing', current_round = p_round + 1, resolving_since = null
  where id = p_game_id and phase = 'resolving';
end;
$$;
