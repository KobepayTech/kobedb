-- ── Sample application data so the REST API and Studio have something to show ──

create table if not exists public.todos (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  title       text not null,
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Enable realtime change-streaming on the todos table.
select public.kobedb_enable_realtime('public', 'todos');

insert into public.todos (title, done) values
  ('Welcome to KobeDB 👋', false),
  ('Try the REST API at /rest/v1/todos', false),
  ('Open Studio at /studio', true)
on conflict do nothing;

-- A default public storage bucket.
insert into storage.buckets (id, public) values ('public', true)
on conflict do nothing;
