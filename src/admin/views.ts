export function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => `&#${c.charCodeAt(0)};`,
  );
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · location-tracker</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  nav a { margin-right: 1rem; }
  nav { margin-bottom: 1.5rem; border-bottom: 1px solid #8884; padding-bottom: .75rem; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { border: 1px solid #8884; padding: .35rem .6rem; text-align: left; }
  input, select { padding: .3rem; margin: .15rem 0; }
  label { display: inline-block; min-width: 8rem; }
  .card { border: 1px solid #8884; border-radius: .5rem; padding: 1rem; margin-bottom: 1rem; }
  .muted { opacity: .65; font-size: .85rem; }
  button { padding: .35rem .9rem; cursor: pointer; }
  code { background: #8882; padding: .1rem .3rem; border-radius: .25rem; }
</style>
</head>
<body>
<nav>
  <a href="/admin">Dashboard</a>
  <a href="/admin/locations">Locations</a>
  <a href="/admin/geofences">Geofences</a>
  <a href="/admin/webhooks">Webhooks</a>
  <a href="/admin/deliveries">Deliveries</a>
  <a href="/admin/setup">Setup</a>
  <form method="post" action="/logout" style="display:inline"><button type="submit">Log out</button></form>
</nav>
${body}
</body>
</html>`;
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
