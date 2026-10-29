-- Mosaico · schema.sql
--
-- Run the whole file in the database's SQL editor. It is safe to run again: it never deletes data.
-- It contains no keys and no personal data, so it can be published. Staff data never goes in any file:
-- accounts are created from the app's Users tab, and subjects from the Subjects tab.
--
-- First admin: create the account in the authentication panel, then give it its role, either typing
--   insert into public.staff (user_id, email, role)
--   select id, lower(email), 'admin' from auth.users where email = '<your email>';
-- or with a private seed.sql (git-ignored) that sets roles and loads the initial subjects and teachers.

-- ---------- 1. Tables ----------

create table if not exists public.students (
  id         text primary key,
  course     text not null,
  name       text not null check (length(trim(name)) > 0 and char_length(name) <= 150),
  country    text not null check (country ~ '^[A-Z]{2}$'),
  career     text not null default '—' check (char_length(career) <= 150),
  created_at timestamptz not null default now()
);
create index if not exists students_course_idx on public.students (course, created_at);

create table if not exists public.rounds (
  id         text primary key,
  course     text not null,
  title      text not null default '' check (char_length(title) <= 400),
  date       date,
  teams      jsonb not null check (
    jsonb_typeof(teams) = 'array'
    and not jsonb_path_exists(teams, 'strict $[*] ? (@.type() != "array")')
    and not jsonb_path_exists(teams, 'strict $[*][*] ? (@.type() != "string")')
  ),
  created_at timestamptz not null default now()
);
create index if not exists rounds_course_idx on public.rounds (course, created_at);

-- One row per account with access, holding its role. 'admin' manages everything; 'coordinator' has exactly the
-- admin's permissions and can teach subjects (it can be assigned subjects); 'professor' only forms and saves teams for
-- their own subjects. Written only by the admin-users function, except the first admin (see the top of this file).
create table if not exists public.staff (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique,
  role       text not null check (role in ('admin', 'coordinator', 'professor')),
  created_at timestamptz not null default now()
);

-- Program subjects and the teachers allowed to save rounds under each one. Managed by the admin (Subjects tab).
create table if not exists public.subjects (
  name     text primary key check (length(trim(name)) > 0 and char_length(name) <= 200),
  position integer not null default 0
);
create table if not exists public.subject_teachers (
  email   text not null check (email = lower(email)),
  subject text not null references public.subjects (name) on update cascade on delete cascade,
  primary key (email, subject)
);

-- ---------- 2. Functions ----------

-- Role of the caller. SECURITY DEFINER avoids recursive policy evaluation on "staff".
create or replace function public.app_role()
returns text
language sql stable security definer
set search_path = public
as $$ select role from public.staff where user_id = auth.uid() $$;

revoke all on function public.app_role() from public, anon;
grant execute on function public.app_role() to authenticated;

-- Email the caller has in "staff". Subject rules use this one, not the email in the token, so changing
-- the account email cannot inherit another person's subjects.
create or replace function public.app_email()
returns text
language sql stable security definer
set search_path = public
as $$ select email from public.staff where user_id = auth.uid() $$;

revoke all on function public.app_email() from public, anon;
grant execute on function public.app_email() to authenticated;

-- Used by the keep-alive workflow: answers without exposing any data.
create or replace function public.ping()
returns integer
language sql stable
as $$ select 1 $$;

grant execute on function public.ping() to anon, authenticated;

-- ---------- 3. Row Level Security ----------

alter table public.students         enable row level security;
alter table public.rounds           enable row level security;
alter table public.staff            enable row level security;
alter table public.subjects         enable row level security;
alter table public.subject_teachers enable row level security;

-- Minimal, explicit grants; the policies below then decide which rows. Without a session (public anon key)
-- nothing can be read or written. "staff" is written only by the admin-users function (service key).
revoke all on public.students, public.rounds, public.staff,
              public.subjects, public.subject_teachers from anon, authenticated;
grant select, insert, update, delete on public.students         to authenticated;
grant select, insert, delete         on public.rounds           to authenticated; -- rounds are never edited
grant select                         on public.staff            to authenticated;
grant select, insert, update, delete on public.subjects         to authenticated; -- writes: admin only (policy)
grant select, insert, delete         on public.subject_teachers to authenticated; -- writes: admin only (policy)
-- The admin-users function works with the service role. New projects no longer grant tables to it automatically,
-- so it gets exactly what it uses: read and write the staff roles, and drop a deleted person's subject assignments.
grant select, insert, update, delete on public.staff            to service_role;
grant select, delete                 on public.subject_teachers to service_role;

-- students: every staff member reads; only admins and coordinators write.
drop policy if exists students_read   on public.students;
drop policy if exists students_insert on public.students;
drop policy if exists students_update on public.students;
drop policy if exists students_delete on public.students;
create policy students_read on public.students for select to authenticated
  using (public.app_role() in ('admin', 'coordinator', 'professor'));
create policy students_insert on public.students for insert to authenticated
  with check (public.app_role() in ('admin', 'coordinator'));
create policy students_update on public.students for update to authenticated
  using (public.app_role() in ('admin', 'coordinator'))
  with check (public.app_role() in ('admin', 'coordinator'));
create policy students_delete on public.students for delete to authenticated
  using (public.app_role() in ('admin', 'coordinator'));

-- rounds: every staff member reads. Admins and coordinators save under any subject; a professor only when the
-- title is one of their subjects, alone or followed by " · activity" (the format the app writes). Only admins and coordinators delete.
drop policy if exists rounds_read   on public.rounds;
drop policy if exists rounds_insert on public.rounds;
drop policy if exists rounds_delete on public.rounds;
create policy rounds_read on public.rounds for select to authenticated
  using (public.app_role() in ('admin', 'coordinator', 'professor'));
create policy rounds_insert on public.rounds for insert to authenticated
  with check (
    public.app_role() in ('admin', 'coordinator')
    or (
      public.app_role() = 'professor'
      and exists (
        select 1
        from public.subject_teachers st
        where st.email = public.app_email()
          and (title = st.subject or starts_with(title, st.subject || ' · '))
      )
    )
  );
create policy rounds_delete on public.rounds for delete to authenticated
  using (public.app_role() in ('admin', 'coordinator'));

-- staff: everyone reads their own row (the app checks it on sign-in); admins read all.
drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select to authenticated
  using (user_id = auth.uid() or public.app_role() in ('admin', 'coordinator'));

-- subjects: every staff member reads; only admins and coordinators write.
drop policy if exists subjects_read        on public.subjects;
drop policy if exists subjects_admin_write on public.subjects;
create policy subjects_read on public.subjects for select to authenticated
  using (public.app_role() in ('admin', 'coordinator', 'professor'));
create policy subjects_admin_write on public.subjects for all to authenticated
  using (public.app_role() in ('admin', 'coordinator')) with check (public.app_role() in ('admin', 'coordinator'));

-- subject_teachers: a professor reads only their own rows (they fill the subject dropdown);
-- admins and coordinators read all and are the only ones who write.
drop policy if exists subject_teachers_read        on public.subject_teachers;
drop policy if exists subject_teachers_admin_write on public.subject_teachers;
create policy subject_teachers_read on public.subject_teachers for select to authenticated
  using (email = public.app_email() or public.app_role() in ('admin', 'coordinator'));
create policy subject_teachers_admin_write on public.subject_teachers for all to authenticated
  using (public.app_role() in ('admin', 'coordinator')) with check (public.app_role() in ('admin', 'coordinator'));

