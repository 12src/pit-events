const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store'
}

const columns = 'name, type, time'
const now = () => new Date().toISOString().slice(0, 16) + 'Z'

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url)

    if (request.method === 'GET' && pathname === '/') {
      const { results } = await env.DB.withSession().prepare(`SELECT ${columns} FROM events WHERE time >= ? ORDER BY time`).bind(now()).all()
      return Response.json(results, { headers })
    }

    if (request.method === 'GET' && pathname === '/history') {
      const from = searchParams.get('from')
      const to = searchParams.get('to')
      const name = searchParams.get('name')
      const type = searchParams.get('type')
      const limit = Number(searchParams.get('limit') ?? 1000)
      const offset = Number(searchParams.get('offset') ?? 0)
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000 || !Number.isInteger(offset) || offset < 0 ||
          [from, to].some(value => value !== null && Number.isNaN(Date.parse(value))) ||
          (type !== null && !['major', 'minor'].includes(type))) {
        return Response.json({ error: 'Invalid query' }, { status: 400, headers })
      }
      const conditions = ['time < ?']
      const values = [now()]
      if (from !== null) {
        conditions.push('time >= ?')
        values.push(from)
      }
      if (to !== null) {
        conditions.push('time <= ?')
        values.push(to)
      }
      if (name !== null) {
        conditions.push('name = ?')
        values.push(name)
      }
      if (type !== null) {
        conditions.push('type = ?')
        values.push(type)
      }
      const { results } = await env.DB.withSession().prepare(`SELECT ${columns} FROM events WHERE ${conditions.join(' AND ')} ORDER BY time LIMIT ? OFFSET ?`)
        .bind(...values, limit, offset).all()
      return Response.json(results, { headers })
    }

    if (request.method !== 'PUT' || pathname !== '/') {
      return Response.json({ error: 'Not found' }, { status: 404, headers })
    }
    if (!env.UPLOAD_KEY) {
      return Response.json({ error: 'Upload key is not configured' }, { status: 503, headers })
    }
    const encoder = new TextEncoder()
    const [provided, expected] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('Authorization') ?? '')),
      crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${env.UPLOAD_KEY}`))
    ])
    if (!crypto.subtle.timingSafeEqual(provided, expected)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
    }

    let size = 0
    let data
    try {
      const body = request.body?.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          size += chunk.byteLength
          if (size > 262144) throw new Error('Upload too large')
          controller.enqueue(chunk)
        }
      }))
      data = await new Response(body).json()
    } catch {
      return Response.json({ error: size > 262144 ? 'Upload too large' : 'Invalid JSON' }, { status: size > 262144 ? 413 : 400, headers })
    }
    if (!Array.isArray(data) || !data.length ||
        !data.every(event => typeof event?.name === 'string' && event.name.length > 0 &&
          ['major', 'minor'].includes(event.type) &&
          typeof event.time === 'string' && !Number.isNaN(Date.parse(event.time)))) {
      return Response.json({ error: 'Invalid event data' }, { status: 400, headers })
    }
    await env.DB.batch(data.map(event =>
      env.DB.prepare('INSERT OR IGNORE INTO events (name, type, time) VALUES (?, ?, ?)').bind(event.name, event.type, event.time)))
    return new Response(null, { status: 204, headers })
  }
}
