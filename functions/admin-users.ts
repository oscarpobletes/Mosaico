// Function "admin-users": account management behind the Users tab. Admins and coordinators only.
// Deploy it as a function named exactly "admin-users" (for example, pasted into the dashboard's function editor).
//
// The service key is injected by Supabase as an environment variable, so nothing secret lives in the repository.
// Deploy with JWT verification enabled (the default). Optional: set ALLOWED_ORIGIN to restrict browser calls.
//
// Request body: { action: 'list' | 'create' | 'role' | 'password' | 'delete', email?, password?, role? }
// Failures answer HTTP 200 with { error: <code> } so the app can translate them.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';

const ROLES = ['admin', 'coordinator', 'professor'] as const;
// Roles that manage the app. A coordinator has the same permissions as an admin and also teaches.
const MANAGER_ROLES: readonly string[] = ['admin', 'coordinator'];
type Role = (typeof ROLES)[number];
type Action = 'list' | 'create' | 'role' | 'password' | 'delete';

const ACTIONS: readonly Action[] = ['list', 'create', 'role', 'password', 'delete'];
const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72; // bcrypt ignores everything past 72 bytes
const USERS_PAGE_SIZE = 1000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  Vary: 'Origin',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

class ApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface Input {
  action: Action;
  email: string;
  password: string;
  role: string;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);
const isValidPassword = (value: string) =>
  value.length >= MIN_PASSWORD_LENGTH && value.length <= MAX_PASSWORD_LENGTH;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

// The server key is injected by Supabase: the new secret key (SUPABASE_SECRET_KEYS, a JSON dictionary) when the
// project has one, otherwise the legacy service_role key. Neither ever appears in the repository.
function serverKey(): string {
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (keys) {
    try {
      const key = JSON.parse(keys).default;
      if (key) return key;
    } catch {
      // malformed: fall back to the legacy variable
    }
  }
  return requireEnv('SUPABASE_SERVICE_ROLE_KEY');
}

function parseInput(body: Record<string, unknown>): Input {
  const action = String(body.action ?? '');
  if (!ACTIONS.includes(action as Action)) throw new ApiError('unknown_action');
  return {
    action: action as Action,
    email: String(body.email ?? '').trim().toLowerCase(),
    password: String(body.password ?? ''),
    role: String(body.role ?? ''),
  };
}

async function requireAdmin(db: SupabaseClient, request: Request): Promise<string> {
  const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data } = await db.auth.getUser(token);
  if (!data?.user) throw new ApiError('unauthorized');
  if (!MANAGER_ROLES.includes((await roleOf(db, data.user.id)) ?? '')) throw new ApiError('forbidden');
  return data.user.id;
}

async function roleOf(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db.from('staff').select('role').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data?.role ?? null;
}

async function countAdmins(db: SupabaseClient): Promise<number> {
  const { count, error } = await db
    .from('staff')
    .select('user_id', { count: 'exact', head: true })
    .in('role', MANAGER_ROLES);
  if (error) throw error;
  return count ?? 0;
}

async function findUserId(db: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: USERS_PAGE_SIZE });
    if (error) throw error;
    const match = data.users.find((user) => user.email?.toLowerCase() === email);
    if (match) return match.id;
    if (data.users.length < USERS_PAGE_SIZE) return null;
  }
}

async function saveRole(db: SupabaseClient, userId: string, email: string, role: Role) {
  const { error } = await db.from('staff').upsert({ user_id: userId, email, role }, { onConflict: 'user_id' });
  if (error) throw error;
}

async function assertAdminRemains(db: SupabaseClient, userId: string) {
  // "admin" here means anyone who can manage the app (admin or coordinator): at least one must remain.
  if (MANAGER_ROLES.includes((await roleOf(db, userId)) ?? '') && (await countAdmins(db)) <= 1) throw new ApiError('last_admin');
}

async function listUsers(db: SupabaseClient) {
  const { data, error } = await db.from('staff').select('email, role').order('email');
  if (error) throw error;
  return { users: data };
}

async function createUser(db: SupabaseClient, { email, password, role }: Input) {
  if (!isValidPassword(password)) throw new ApiError('invalid_password');
  if (!isRole(role)) throw new ApiError('invalid_role');
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error.code === 'email_exists' ? new ApiError('email_exists') : error;
  if (!data.user) throw new Error('createUser returned no user');
  await saveRole(db, data.user.id, email, role);
}

async function changeRole(db: SupabaseClient, callerId: string, { email, role }: Input, userId: string) {
  if (!isRole(role)) throw new ApiError('invalid_role');
  if (!MANAGER_ROLES.includes(role)) {
    if (userId === callerId) throw new ApiError('self_demote');
    await assertAdminRemains(db, userId);
  }
  await saveRole(db, userId, email, role);
}

async function changePassword(db: SupabaseClient, { password }: Input, userId: string) {
  if (!isValidPassword(password)) throw new ApiError('invalid_password');
  const { error } = await db.auth.admin.updateUserById(userId, { password });
  if (error) throw error;
}

async function deleteUser(db: SupabaseClient, callerId: string, userId: string, email: string) {
  if (userId === callerId) throw new ApiError('self_delete');
  await assertAdminRemains(db, userId);
  const { error } = await db.auth.admin.deleteUser(userId); // public.staff cascades
  if (error) throw error;
  // Subject assignments are keyed by email, not by account: drop them so a future account with the same
  // address does not silently inherit them.
  const cleanup = await db.from('subject_teachers').delete().eq('email', email);
  if (cleanup.error) throw cleanup.error;
}

async function handle(db: SupabaseClient, callerId: string, input: Input) {
  if (input.action === 'list') return listUsers(db);
  if (!EMAIL_PATTERN.test(input.email)) throw new ApiError('invalid_email');
  if (input.action === 'create') {
    await createUser(db, input);
    return { ok: true };
  }

  const userId = await findUserId(db, input.email);
  if (!userId) throw new ApiError('user_not_found');
  if (input.action === 'role') await changeRole(db, callerId, input, userId);
  if (input.action === 'password') await changePassword(db, input, userId);
  if (input.action === 'delete') await deleteUser(db, callerId, userId, input.email);
  return { ok: true };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  try {
    const db = createClient(requireEnv('SUPABASE_URL'), serverKey(), {
      auth: { persistSession: false },
    });
    const callerId = await requireAdmin(db, request);
    const input = parseInput(await request.json().catch(() => ({})));
    return json(await handle(db, callerId, input));
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.code });
    console.error(error);
    return json({ error: 'internal_error' });
  }
});
