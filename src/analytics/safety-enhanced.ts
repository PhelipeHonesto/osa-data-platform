/**
 * NTSB-enhanced safety analytics.
 *
 * Joins ntsb_accidents with faa_aircraft and faa_operators
 * for operator safety scoring, aircraft type risk, and airport incidents.
 */

import type Database from "better-sqlite3";

// ── Types ───────────────────────────────────────────────────────────────────

export interface OperatorAccident {
  eventId: string;
  eventDate: string;
  location: string | null;
  registrationNumber: string | null;
  aircraftMake: string | null;
  aircraftModel: string | null;
  injurySeverity: string | null;
  aircraftDamage: string | null;
  totalFatalInjuries: number;
  totalSeriousInjuries: number;
  weatherCondition: string | null;
  broadPhaseOfFlight: string | null;
  farDescription: string | null;
}

export interface AircraftTypeRisk {
  aircraftModel: string;
  totalAccidents: number;
  fatalAccidents: number;
  seriousAccidents: number;
  totalFatalities: number;
  totalRegistered: number;
  accidentsPer1000: number;
}

export interface AirportIncident {
  eventId: string;
  eventDate: string;
  registrationNumber: string | null;
  aircraftMake: string | null;
  aircraftModel: string | null;
  injurySeverity: string | null;
  aircraftDamage: string | null;
  totalFatalInjuries: number;
  broadPhaseOfFlight: string | null;
  farDescription: string | null;
}

export interface FarBreakdown {
  farDescription: string;
  totalAccidents: number;
  fatalAccidents: number;
  totalFatalities: number;
  pctOfTotal: number;
}

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * Get all NTSB incidents for an operator.
 * Matches by joining registration_number → faa_aircraft.certificate_holder.
 */
export function getOperatorAccidentHistory(
  db: Database.Database,
  operatorName: string,
): { operator: string; accidents: OperatorAccident[]; summary: Record<string, number> } {
  // Find all tail numbers for this operator
  const accidents = db.prepare(`
    SELECT n.event_id, n.event_date, n.location, n.registration_number,
           n.aircraft_make, n.aircraft_model, n.injury_severity, n.aircraft_damage,
           n.total_fatal_injuries, n.total_serious_injuries,
           n.weather_condition, n.broad_phase_of_flight, n.far_description
    FROM ntsb_accidents n
    JOIN faa_aircraft a ON n.registration_number = a.tail_number
    WHERE a.certificate_holder LIKE ?
    ORDER BY n.event_date DESC
  `).all(`%${operatorName}%`) as Array<{
    event_id: string; event_date: string; location: string | null;
    registration_number: string | null; aircraft_make: string | null;
    aircraft_model: string | null; injury_severity: string | null;
    aircraft_damage: string | null; total_fatal_injuries: number | null;
    total_serious_injuries: number | null; weather_condition: string | null;
    broad_phase_of_flight: string | null; far_description: string | null;
  }>;

  // Also check by operator name directly in NTSB data if available
  const directMatches = db.prepare(`
    SELECT n.event_id, n.event_date, n.location, n.registration_number,
           n.aircraft_make, n.aircraft_model, n.injury_severity, n.aircraft_damage,
           n.total_fatal_injuries, n.total_serious_injuries,
           n.weather_condition, n.broad_phase_of_flight, n.far_description
    FROM ntsb_accidents n
    WHERE n.registration_number IN (
      SELECT tail_number FROM faa_aircraft WHERE certificate_holder LIKE ?
    )
    AND n.event_id NOT IN (${accidents.map(() => "?").join(",") || "''"})
    ORDER BY n.event_date DESC
  `).all(`%${operatorName}%`, ...accidents.map((a) => a.event_id)) as typeof accidents;

  const all = [...accidents, ...directMatches];
  const seen = new Set<string>();
  const unique = all.filter((a) => {
    if (seen.has(a.event_id)) return false;
    seen.add(a.event_id);
    return true;
  });

  let fatal = 0, serious = 0, destroyed = 0;
  for (const a of unique) {
    if (a.injury_severity === "Fatal") fatal++;
    if (a.injury_severity === "Serious") serious++;
    if (a.aircraft_damage === "Destroyed") destroyed++;
  }

  return {
    operator: operatorName,
    accidents: unique.map((a) => ({
      eventId: a.event_id,
      eventDate: a.event_date,
      location: a.location,
      registrationNumber: a.registration_number,
      aircraftMake: a.aircraft_make,
      aircraftModel: a.aircraft_model,
      injurySeverity: a.injury_severity,
      aircraftDamage: a.aircraft_damage,
      totalFatalInjuries: a.total_fatal_injuries ?? 0,
      totalSeriousInjuries: a.total_serious_injuries ?? 0,
      weatherCondition: a.weather_condition,
      broadPhaseOfFlight: a.broad_phase_of_flight,
      farDescription: a.far_description,
    })),
    summary: {
      total: unique.length,
      fatal,
      serious,
      destroyed,
    },
  };
}

/**
 * Get accident rate by aircraft model.
 * Joins with faa_aircraft to compute accidents per 1000 registered aircraft.
 */
export function getAircraftTypeRisk(
  db: Database.Database,
  model: string,
): AircraftTypeRisk {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_accidents,
      SUM(CASE WHEN injury_severity = 'Fatal' THEN 1 ELSE 0 END) as fatal,
      SUM(CASE WHEN injury_severity = 'Serious' THEN 1 ELSE 0 END) as serious,
      SUM(COALESCE(total_fatal_injuries, 0)) as fatalities
    FROM ntsb_accidents
    WHERE aircraft_model LIKE ?
  `).get(`%${model}%`) as {
    total_accidents: number; fatal: number; serious: number; fatalities: number;
  };

  const registered = db.prepare(`
    SELECT COUNT(*) as cnt FROM faa_aircraft WHERE model LIKE ?
  `).get(`%${model}%`) as { cnt: number };

  const per1000 = registered.cnt > 0
    ? Math.round((stats.total_accidents / registered.cnt) * 10000) / 10
    : 0;

  return {
    aircraftModel: model,
    totalAccidents: stats.total_accidents,
    fatalAccidents: stats.fatal,
    seriousAccidents: stats.serious,
    totalFatalities: stats.fatalities,
    totalRegistered: registered.cnt,
    accidentsPer1000: per1000,
  };
}

/**
 * Get incidents at or near an airport by ICAO or FAA code.
 */
export function getAirportIncidents(
  db: Database.Database,
  icao: string,
  limit = 50,
): { airport: string; incidents: AirportIncident[]; total: number; fatalCount: number } {
  const incidents = db.prepare(`
    SELECT event_id, event_date, registration_number, aircraft_make, aircraft_model,
           injury_severity, aircraft_damage, total_fatal_injuries,
           broad_phase_of_flight, far_description
    FROM ntsb_accidents
    WHERE airport_code = ? OR airport_code = ?
    ORDER BY event_date DESC
    LIMIT ?
  `).all(icao, icao.replace(/^K/, ""), limit) as Array<{
    event_id: string; event_date: string; registration_number: string | null;
    aircraft_make: string | null; aircraft_model: string | null;
    injury_severity: string | null; aircraft_damage: string | null;
    total_fatal_injuries: number | null; broad_phase_of_flight: string | null;
    far_description: string | null;
  }>;

  const totalRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM ntsb_accidents
    WHERE airport_code = ? OR airport_code = ?
  `).get(icao, icao.replace(/^K/, "")) as { cnt: number };

  const fatalRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM ntsb_accidents
    WHERE (airport_code = ? OR airport_code = ?) AND injury_severity = 'Fatal'
  `).get(icao, icao.replace(/^K/, "")) as { cnt: number };

  return {
    airport: icao,
    incidents: incidents.map((i) => ({
      eventId: i.event_id,
      eventDate: i.event_date,
      registrationNumber: i.registration_number,
      aircraftMake: i.aircraft_make,
      aircraftModel: i.aircraft_model,
      injurySeverity: i.injury_severity,
      aircraftDamage: i.aircraft_damage,
      totalFatalInjuries: i.total_fatal_injuries ?? 0,
      broadPhaseOfFlight: i.broad_phase_of_flight,
      farDescription: i.far_description,
    })),
    total: totalRow.cnt,
    fatalCount: fatalRow.cnt,
  };
}

/**
 * Breakdown of accidents by FAR part (91 vs 135 vs 121).
 */
export function getFarBreakdown(db: Database.Database): FarBreakdown[] {
  const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM ntsb_accidents`).get() as { cnt: number };
  const total = totalRow.cnt || 1;

  const rows = db.prepare(`
    SELECT
      far_description,
      COUNT(*) as total_accidents,
      SUM(CASE WHEN injury_severity = 'Fatal' THEN 1 ELSE 0 END) as fatal,
      SUM(COALESCE(total_fatal_injuries, 0)) as fatalities
    FROM ntsb_accidents
    WHERE far_description IS NOT NULL AND far_description != ''
    GROUP BY far_description
    ORDER BY total_accidents DESC
    LIMIT 20
  `).all() as Array<{
    far_description: string; total_accidents: number; fatal: number; fatalities: number;
  }>;

  return rows.map((r) => ({
    farDescription: r.far_description,
    totalAccidents: r.total_accidents,
    fatalAccidents: r.fatal,
    totalFatalities: r.fatalities,
    pctOfTotal: Math.round((r.total_accidents / total) * 1000) / 10,
  }));
}
