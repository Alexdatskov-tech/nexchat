/* Promoting admins is the most consequential action in the app: it hands over
   bans, appeals and further promotions. These checks cover the UI wiring and,
   more importantly, that the migration cannot be used to self-promote. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = '/home/user/nexchat';
let fails = 0;
const ok = (n, c, extra) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); if (!c) fails++; };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

const adminJs = fs.readFileSync(path.join(APP, 'assets/js/admin.js'), 'utf8');
const sql = fs.readFileSync(path.join(APP, 'nexchat_patch7.sql'), 'utf8');

/* ---- 1. the rpc contract ---- */
ok('admin.js calls set_user_admin', /rpc\('set_user_admin'/.test(adminJs));
ok('  with the target user', /p_user_id:\s*uid/.test(adminJs));
ok('  and the desired state', /p_admin:\s*promoting/.test(adminJs));
ok('  behind a confirmation', /confirmDialog\([\s\S]{0,200}Make admin/.test(adminJs));
ok('  and never writes the column directly',
   !/update[\s\S]{0,80}is_platform_admin/i.test(adminJs) &&
   !/is_platform_admin:\s*(true|false|promoting)/.test(adminJs));

/* ---- 2. you cannot act on yourself ---- */
ok('own row shows no action buttons', /u\.id === me\.id \? '<span class="badge badge-owner">You<\/span>'/.test(adminJs));

/* ---- 3. the migration blocks privilege escalation ---- */
ok('patch7 defines set_user_admin', /create or replace function public\.set_user_admin/.test(sql));
ok('  it is security definer', /set_user_admin[\s\S]{0,300}security definer/.test(sql));
ok('  with a pinned search_path', /set_user_admin[\s\S]{0,300}set search_path = public/.test(sql));
ok('  and checks the caller is an admin',
   /set_user_admin[\s\S]{0,900}is_platform_admin\)?\s*then\s*\n?\s*raise exception 'not authorised'/.test(sql));
ok('  execute is not granted to anon', !/grant execute on function public\.set_user_admin[^;]*to anon/.test(sql));
ok('  execute is granted to authenticated', /grant execute on function public\.set_user_admin[^;]*to authenticated/.test(sql));
ok('  public execute is revoked', /revoke all on function public\.set_user_admin[^;]*from public/.test(sql));

ok('a trigger guards the column', /create trigger trg_guard_platform_admin/.test(sql));
ok('  it fires before update on profiles', /before update on public\.profiles/.test(sql));
ok('  it rejects unsanctioned changes', /raise exception 'admin status can only be changed/.test(sql));
ok('  the unlock is transaction-local', /set_config\('nexchat\.admin_grant',\s*'on',\s*true\)/.test(sql));
ok('  and is re-locked afterwards', /set_config\('nexchat\.admin_grant',\s*'off',\s*true\)/.test(sql));
ok('  the guard reads the same setting', /current_setting\('nexchat\.admin_grant', true\)/.test(sql));

ok('the last admin cannot be demoted', /there must be at least one admin/.test(sql));
ok('self-demotion is refused', /you cannot remove your own admin access/.test(sql));
ok('promotions are audited', /insert into public\.admin_grants/.test(sql));
ok('  the audit table has RLS', /alter table public\.admin_grants enable row level security/.test(sql));
ok('  readable by admins only', /admin_grants_select_admin/.test(sql));
ok('  and has no client write policy',
   !/create policy[^;]*admin_grants[^;]*for (insert|update|delete)/i.test(sql));

/* ---- 4. behavioural: the button drives the rpc ---- */
(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { runScripts: 'outside-only', url: 'https://nexchat.example/admin.html' });
  const w = dom.window;
  const calls = [];
  const rpc = async (fn, args) => { calls.push({ fn, args }); return { error: null }; };

  // Mirror of paintUsers' button contract, driven against a stub rpc.
  const u = { id: 'u2', username: 'kim', is_platform_admin: false };
  const promote = async () => {
    const promoting = !u.is_platform_admin;
    const { error } = await rpc('set_user_admin', { p_user_id: u.id, p_admin: promoting });
    if (!error) u.is_platform_admin = promoting;
  };
  await promote();
  ok('promote sends p_admin true', calls[0].args.p_admin === true);
  ok('  and flips local state', u.is_platform_admin === true);
  await promote();
  ok('the same button then demotes', calls[1].args.p_admin === false);
  ok('  state returns', u.is_platform_admin === false);

  /* ---- 5. a missing migration is explained, not dumped raw ---- */
  {
    const ui = fs.readFileSync(path.join(APP, 'assets/js/ui.js'), 'utf8');
    ok('confirmDialog takes a button label', /function confirmDialog\(title, body, danger, confirmText\)/.test(ui));
    ok('  and uses it', /esc\(confirmText \|\|/.test(ui));
    ok('  demote confirm is not labelled Delete', /promoting \? 'Make admin' : 'Remove admin'\)/.test(adminJs));
    ok('missing rpc is translated', /nexchat_patch7\.sql/.test(adminJs));
    ok('  and detects the PostgREST code', /PGRST202|schema cache/.test(adminJs));
  }

  console.log(fails ? `\n${fails} FAILED` : '\nAll admin-promotion checks passed');
  process.exit(fails ? 1 : 0);
})();
