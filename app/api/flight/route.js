import { userFromRequest } from '../../../lib/oauth';
export const runtime = 'nodejs';

// Busca dados de um voo pelo numero (ex.: LA3302, TP1234) via AviationStack (plano free).
// Requer AVIATIONSTACK_KEY nas variaveis de ambiente. Sem chave -> retorna vazio (o app segue manual).
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const flight = (sp.get('flight') || '').replace(/\s+/g, '').toUpperCase();
  if (!flight) return Response.json({ error: 'Informe o número do voo.' }, { status: 400 });

  const key = process.env.AVIATIONSTACK_KEY;
  if (!key) return Response.json({ configured: false, flight: null });

  try {
    const url = `https://api.aviationstack.com/v1/flights?access_key=${key}&flight_iata=${flight}`;
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(9000) });
    const j = await r.json();
    if (j.error) return Response.json({ configured: true, flight: null, error: j.error.message || 'erro' });
    const f = (j.data || [])[0];
    if (!f) return Response.json({ configured: true, flight: null });
    const out = {
      flightNumber: (f.flight && (f.flight.iata || f.flight.number)) || flight,
      airline: f.airline && f.airline.name,
      status: f.flight_status,
      depAirport: f.departure && f.departure.airport,
      depIata: f.departure && f.departure.iata,
      depTerminal: f.departure && f.departure.terminal,
      depGate: f.departure && f.departure.gate,
      depTime: f.departure && (f.departure.scheduled || f.departure.estimated),
      arrAirport: f.arrival && f.arrival.airport,
      arrIata: f.arrival && f.arrival.iata,
      arrTerminal: f.arrival && f.arrival.terminal,
      arrGate: f.arrival && f.arrival.gate,
      arrTime: f.arrival && (f.arrival.scheduled || f.arrival.estimated),
      aircraft: (f.aircraft && (f.aircraft.iata || f.aircraft.icao || f.aircraft.registration)) || null,
      aircraftReg: f.aircraft && f.aircraft.registration,
    };
    return Response.json({ configured: true, flight: out });
  } catch (e) {
    return Response.json({ configured: true, flight: null, error: String(e.message || e) });
  }
}
