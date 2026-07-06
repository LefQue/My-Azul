-- Azul multijoueur : schéma Supabase
-- À coller dans Supabase → SQL Editor → New query → Run

create extension if not exists pgcrypto;

-- ---------- tables ----------

create table if not exists games (
  id              uuid primary key default gen_random_uuid(),
  join_code       text not null unique,
  phase           text not null default 'lobby',   -- lobby | playing | resolving | ended
  current_round   int  not null default 1,
  max_players     int  not null default 4 check (max_players between 2 and 4),
  resolving_since timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists games_join_code_idx on games (join_code);

create table if not exists players (
  id                       uuid primary key default gen_random_uuid(),
  game_id                  uuid not null references games(id) on delete cascade,
  slot_index               int  not null,
  name                     text,
  claimed_by_device_id     text,
  wall                     jsonb not null default '[[null,null,null,null,null],[null,null,null,null,null],[null,null,null,null,null],[null,null,null,null,null],[null,null,null,null,null]]',
  pattern_lines            jsonb not null default '[{"capacity":1,"color":null,"count":0},{"capacity":2,"color":null,"count":0},{"capacity":3,"color":null,"count":0},{"capacity":4,"color":null,"count":0},{"capacity":5,"color":null,"count":0}]',
  floor_filled             int  not null default 0,
  has_first_player_marker  boolean not null default false,
  total_score              int  not null default 0,
  round_history            jsonb not null default '[]',
  final_bonuses            jsonb,
  ready                    boolean not null default false,
  updated_at               timestamptz not null default now(),
  unique (game_id, slot_index)
);
create index if not exists players_game_id_idx on players (game_id);

-- ---------- row level security ----------
-- Politique ouverte à `anon` : n'importe qui connaissant le join_code (via l'UI) peut lire/écrire
-- la partie correspondante. Comme discuté : la clé publique + cette politique signifient que
-- n'importe qui appelant l'API Supabase directement (pas juste via notre UI) pourrait aussi lire/
-- écrire n'importe quelle partie, pas seulement celle dont il connaît le code. Acceptable pour un
-- jeu de score occasionnel entre amis, sans données sensibles ni compte utilisateur.

alter table games   enable row level security;
alter table players enable row level security;

create policy games_all   on games   for all to anon using (true) with check (true);
create policy players_all on players for all to anon using (true) with check (true);

-- ---------- résolution de manche basée sur "Prêt" ----------
-- Verrouille la ligne `games` (for update) pour garantir qu'un seul appel concurrent peut
-- effectivement faire passer la partie en phase 'resolving', même si plusieurs joueurs
-- tapent "Prêt" au même instant.

create or replace function try_claim_round_resolution(p_game_id uuid, p_round int)
returns boolean language plpgsql as $$
declare
  v_all_ready boolean;
  v_claimed   boolean;
begin
  perform 1 from games where id = p_game_id for update;

  -- uniquement les sièges réclamés : un siège jamais rejoint reste ready=false pour toujours et
  -- bloquerait sinon la résolution indéfiniment (ex: partie créée pour 3 mais seulement 2 présents)
  select bool_and(ready) into v_all_ready from players
    where game_id = p_game_id and claimed_by_device_id is not null;
  if not coalesce(v_all_ready, false) then
    return false;
  end if;

  update games set phase = 'resolving', resolving_since = now()
  where id = p_game_id and current_round = p_round and phase = 'playing'
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

-- Persiste les résultats déjà calculés côté client (endRoundForPlayer en JS) et avance la manche.
-- Volontairement sans aucune règle de score ici : juste "écrire ces lignes, avancer le round".

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
    updated_at              = now()
  from jsonb_to_recordset(p_results)
    as r(id uuid, wall jsonb, pattern_lines jsonb, floor_filled int, total_score int, round_history_entry jsonb)
  where p.id = r.id and p.game_id = p_game_id;

  update games set phase = 'playing', current_round = p_round + 1, resolving_since = null
  where id = p_game_id and phase = 'resolving';
end;
$$;

-- Filet de sécurité : si l'appareil qui a "gagné" la résolution plante avant d'appeler
-- apply_round_results, la partie resterait bloquée en 'resolving'. N'importe quel client
-- peut appeler ceci après un court délai pour débloquer et laisser un autre réessayer.

create or replace function force_unclaim_stuck_round(p_game_id uuid, p_round int)
returns void language plpgsql as $$
begin
  update games set phase = 'playing', resolving_since = null
  where id = p_game_id and current_round = p_round and phase = 'resolving'
    and resolving_since < now() - interval '8 seconds';
end;
$$;

-- ---------- realtime ----------
-- Active la réplication temps réel sur les deux tables (nécessaire pour que les abonnements
-- postgres_changes fonctionnent côté client).

alter publication supabase_realtime add table games, players;
