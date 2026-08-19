/* The SQL patches are pasted into the Supabase editor by hand, so a syntax
   error is only discovered by the user, mid-migration. Parse them here with
   the real Postgres grammar instead. Also pins the things that made a paste
   go wrong in practice: non-ASCII bytes, and no way to tell a truncated run
   from a complete one. */
const fs = require('fs');
const path = require('path');
const { parse } = require('pgsql-parser');

const APP = '/home/user/nexchat';
let fails = 0;
const ok = (n, c, extra) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); if (!c) fails++; };

(async () => {
  const files = fs.readdirSync(APP).filter((f) => /^nexchat_patch\d+\.sql$/.test(f)).sort();
  ok('patch files found', files.length >= 4, files.join(', '));

  for (const f of files) {
    const sql = fs.readFileSync(path.join(APP, f), 'utf8');

    // 1. It has to parse as Postgres.
    try {
      await parse(sql);
      ok(`${f} parses`, true);
    } catch (e) {
      ok(`${f} parses`, false, e.message);
    }

    // 2. Non-ASCII survives a clipboard round-trip badly, and an em dash two
    //    lines above the break is what preceded a real truncated paste.
    const bad = [...sql].filter((c) => c.charCodeAt(0) > 127);
    ok(`${f} is pure ASCII`, bad.length === 0, bad.length ? `${bad.length} byte(s): ${[...new Set(bad)].join(' ')}` : '');

    // 3. Re-running a patch must not error.
    ok(`${f} claims to be re-runnable`, /safe to re-run/i.test(sql));

    // 4. Every DDL statement should be idempotent, or re-running throws.
    const creates = sql.match(/^\s*create (table|index|unique index|policy|type)\b[^;]*/gim) || [];
    const notGuarded = creates.filter((c) =>
      !/if not exists/i.test(c) && !/^\s*create policy/i.test(c));
    ok(`${f} creates are guarded`, notGuarded.length === 0,
       notGuarded.map((c) => c.split('\n')[0].trim()).join(' | '));

    // A bare `create policy` is only safe if dropped first.
    const policies = [...sql.matchAll(/create policy\s+"?([\w-]+)"?/gi)].map((m) => m[1]);
    const undropped = policies.filter((p) => !new RegExp(`drop policy if exists\\s+"?${p}"?`, 'i').test(sql));
    ok(`${f} policies are dropped before create`, undropped.length === 0, undropped.join(', '));

    // 5. Functions must be replaceable and search_path-pinned (they are
    //    SECURITY DEFINER; an unpinned search_path is a privilege hole).
    const fns = sql.match(/create (or replace )?function[^;]*?\$\$/gis) || [];
    for (const fn of fns) {
      const name = (fn.match(/function\s+([\w.]+)/i) || [])[1] || '?';
      ok(`${f} ${name} is replaceable`, /or replace/i.test(fn));
      if (/security definer/i.test(fn)) {
        ok(`${f} ${name} pins search_path`, /set\s+search_path\s*=/i.test(fn));
      }
    }
  }

  /* A completed run has to be distinguishable from a truncated one. */
  for (const f of ['nexchat_patch5.sql', 'nexchat_patch6.sql']) {
    const sql = fs.readFileSync(path.join(APP, f), 'utf8');
    const stmts = sql.split(';').map((s) => s.trim()).filter((s) => s && !/^--/.test(s.split('\n').pop()));
    const last = stmts[stmts.length - 1] || '';
    ok(`${f} ends with a verification select`, /^select/i.test(last.replace(/^[\s\S]*?\n(?=select)/i, '')) || /select/i.test(last));
    ok(`  ${f} verification checks realtime publication`, /pg_publication_tables/.test(sql));
  }

  {
    const sql = fs.readFileSync(path.join(APP, 'nexchat_patch6.sql'), 'utf8');
    ok('patch6 verifies the appeals table', /to_regclass\('public\.ban_appeals'\)/.test(sql));
    ok('patch6 verifies the resolve function', /to_regproc\([^)]*resolve_ban_appeal/.test(sql));
    ok('patch6 verifies the one-pending index', /idx_ban_appeals_one_pending/.test(sql));
  }

  console.log(fails ? `\n${fails} FAILED` : '\nAll SQL checks passed');
  process.exit(fails ? 1 : 0);
})();
