"""
Convert Parquet flight data to filtered CSV for TypeScript ingestion.
Filters to US-registered charter-class aircraft only.

Usage: python3 src/ingestion/parquet-to-csv.py ~/Downloads/2025_Q4_detailed_github.parquet /tmp/charter-flights.csv
"""

import sys
import ast
import pyarrow.parquet as pq
import csv

CHARTER_TYPES = {
    # Heavy
    "GLF5", "GLF6", "G650", "GLEX", "GL5T", "GL7T", "CL60", "CL61",
    "GALX", "FA7X", "FA8X", "F900", "F2TH", "BD70",
    # Super-mid
    "G280", "CL30", "CL35", "C68A", "C680", "E550", "E545",
    "LJ45", "H25B", "FA50",
    # Midsize
    "G150", "C56X", "C560", "C55B", "E35L", "LJ35", "LJ40",
    "H25A", "BE40", "E55P", "LJ60",
    # Light
    "C25A", "C25B", "C25C", "C25M", "C510", "E500", "PRM1",
    "SF50", "EA50", "C501", "C525", "C526", "HDJT",
    # Turboprop
    "B350", "B200", "PC12", "P180", "TBM7", "TBM8", "TBM9",
    "PAY4", "BE9L", "BE20", "C208",
}

CLASS_MAP = {
    "GLF5": "heavy", "GLF6": "heavy", "G650": "heavy", "GLEX": "heavy",
    "GL5T": "heavy", "GL7T": "heavy", "CL60": "heavy", "CL61": "heavy",
    "GALX": "heavy", "FA7X": "heavy", "FA8X": "heavy",
    "F900": "heavy", "F2TH": "heavy", "BD70": "heavy",
    "G280": "super_mid", "CL30": "super_mid", "CL35": "super_mid",
    "C68A": "super_mid", "C680": "super_mid", "E550": "super_mid",
    "E545": "super_mid", "LJ45": "super_mid", "H25B": "super_mid", "FA50": "super_mid",
    "G150": "midsize", "C56X": "midsize", "C560": "midsize", "C55B": "midsize",
    "E35L": "midsize", "LJ35": "midsize", "LJ40": "midsize",
    "H25A": "midsize", "BE40": "midsize", "E55P": "midsize", "LJ60": "midsize",
    "C25A": "light", "C25B": "light", "C25C": "light", "C25M": "light",
    "C510": "light", "E500": "light", "PRM1": "light",
    "SF50": "light", "EA50": "light", "C501": "light", "C525": "light",
    "C526": "light", "HDJT": "light",
    "B350": "turboprop", "B200": "turboprop", "PC12": "turboprop",
    "P180": "turboprop", "TBM7": "turboprop", "TBM8": "turboprop",
    "TBM9": "turboprop", "PAY4": "turboprop", "BE9L": "turboprop",
    "BE20": "turboprop", "C208": "turboprop",
}


def extract_airport(airports_str):
    """Extract first ICAO code from stringified list like "['KTEB']" or "['KTEB', 'KEWR']" """
    if not airports_str or airports_str == "-":
        return None
    try:
        airports = ast.literal_eval(airports_str)
        if isinstance(airports, list) and len(airports) > 0:
            return airports[0]
    except:
        pass
    return None


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 parquet-to-csv.py <input.parquet> <output.csv>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    print(f"Reading {input_path}...")
    pf = pq.ParquetFile(input_path)
    total_rows = pf.metadata.num_rows
    print(f"Total rows: {total_rows:,}")

    kept = 0
    skipped = 0

    with open(output_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "icao_hex", "tail_number", "aircraft_type", "aircraft_class",
            "operator", "origin_icao", "destination_icao",
            "departure_time", "arrival_time"
        ])

        for rg_idx in range(pf.metadata.num_row_groups):
            table = pf.read_row_group(rg_idx)
            df = table.to_pandas()

            for _, row in df.iterrows():
                reg = str(row.get("Reg", "")).strip()
                ac_type = str(row.get("AC_Type", "")).strip()

                # Filter: US registration + charter type
                if not reg.startswith("N"):
                    skipped += 1
                    continue
                if ac_type not in CHARTER_TYPES:
                    skipped += 1
                    continue

                origin = extract_airport(row.get("Track_Origin_ApplicableAirports"))
                dest = extract_airport(row.get("Track_Destination_ApplicableAirports"))

                # Need at least one US airport
                if not origin and not dest:
                    skipped += 1
                    continue

                dep_time = str(row.get("Track_Origin_DateTime_UTC", "")).strip()
                arr_time = str(row.get("Track_Destination_DateTime_UTC", "")).strip()
                if not dep_time or not arr_time or dep_time == "-" or arr_time == "-":
                    skipped += 1
                    continue

                icao_hex = str(row.get("ICAO_Hex", "")).strip()
                operator = str(row.get("Airline", "")).strip()
                aircraft_class = CLASS_MAP.get(ac_type, "")

                writer.writerow([
                    icao_hex, reg, ac_type, aircraft_class,
                    operator, origin or "", dest or "",
                    dep_time, arr_time
                ])
                kept += 1

            processed = (rg_idx + 1) * (total_rows // pf.metadata.num_row_groups)
            print(f"  Row group {rg_idx + 1}/{pf.metadata.num_row_groups}: {processed:,}/{total_rows:,} processed, {kept:,} kept")

    print(f"\nDone. Kept {kept:,} charter flights, skipped {skipped:,}")
    print(f"Output: {output_path}")


if __name__ == "__main__":
    main()
