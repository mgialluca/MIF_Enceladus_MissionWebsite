"""
instrument_concentrations.py
=============================
Real per-instrument concentration reporting for HIVE and WhiteWhale's
advanced data collection, built from the per-parcel "data bounds"
spreadsheets exported to assets/Data_Bounds/ (dev source of truth) and
copied here to functions/data_bounds/ for Cloud Functions to read at
runtime — same manual-sync pattern as the seafloor .npy data and
sort_particles_flow_cytometer.py's own FlowCyt_Dev twin. Re-copy the 10
CSVs here whenever the spreadsheet changes; every value is read fresh out
of the loaded data on each call (nothing is baked into Python literals), so
a re-copy is the only step needed to pick up new numbers.

Scope: only "concentration" quantities — data_type == 'csv', and units that
are fundamentally molar (see EXCLUDED_UNITS for what's deliberately left
out: physical properties like temperature/pressure/salinity, isotope/
chirality ratios, and pg/ug extract, which is mass- not mole-based).
Everything else (FTIR Spectra, LCMS spectra, Incubation, FC, CTD-pH) has no
in-scope rows here and stays on the placeholder path in main.py.

Position (x, y, z) is blended across parcels exactly like the Flow
Cytometer model — see sort_particles_flow_cytometer.parcel_blend_weights().
Ported from the user-provided assets/Data_Bounds/Sample_Concentration_
Calculation.py (calculate_sample_concentration_bulk /
calculate_sample_concentration_particles), generalized to: blend across
parcels, look a parameter's values up from the spreadsheet instead of
taking them as direct arguments, and sum across multiple selected size
buckets in one analysis.
"""
import csv
import os

import numpy as np

from sort_particles_flow_cytometer import parcel_blend_weights, SIZE_BIN_NAMES

_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data_bounds")
PARCEL_INDICES = (0, 1, 2, 3, 4)

# CSV instrument string (column C, exactly as it appears) -> the website's
# own instrument identifier used everywhere else in main.py/config.js. A
# mapping is necessary because the spreadsheet's strings have inconsistent
# whitespace/casing/underscores-vs-spaces that the website names don't.
CSV_INSTRUMENT_TO_WEBSITE = {
    'ICP-MS': 'ICP-MS',
    'CE-LIF': 'CE-LIF',
    'CRDS': 'CRDS',
    'CTD-pH': 'CTD-pH',
    'GC-BID': 'GC-BID',
    'GCMS': 'GCMS',
    'GCMS_AAChirality': 'GCMS AAChirality',
    'GCMS_Derivatized': 'GCMS Derivatized',
    'IC': 'IC',
    'LCMS': 'LCMS',
    'LCMS_spectra': 'LCMS spectra',
    'FTIR_spectra': 'FTIR Spectra',
    'TC/TN_analyzer': 'TC/TN Analyzer',
    'TOC/DOC analyzer': 'TOC/DOC Analyzer',
}

# units (column B) values that are NOT a molar concentration — rows with
# these are out of scope for now. Everything else, including qualifier-
# suffixed molar units (uM C, mM N, nmol <functional group> / L), is an
# ordinary concentration per explicit instruction — ignore the qualifier,
# scale by the n/u/m prefix only.
EXCLUDED_UNITS = {
    'D/L ratio', 'deg C', 'bar', 'ratio', 'PSU', 'permil', 'km', 'pg/ug extract',
}

# LOD_units (column Q) values that mean "this LOD is a real mol/L-equivalent
# threshold" — mol N/L, mol C/L, and "mol/L (gas)" are fundamentally mol/L
# for calculation purposes, same reasoning as the qualifier-suffixed units
# above. 'resolution' and blank show up only on rows EXCLUDED_UNITS already
# drops, except 4 GCMS hydrocarbons (see _lod_molar) that are genuinely
# missing LOD data in the spreadsheet today.
_MOLAR_LOD_UNITS = {'mol/L', 'mol N/L', 'mol C/L', 'mol/L (gas)'}

# Median diameter (um) per size bucket, matching SIZE_BIN_NAMES order/labels
# exactly (same bins the Flow Cytometer model and the spreadsheet's E-J
# columns both use).
BIN_MEDIAN_UM = {
    '<0.5um': 0.26, '0.5-1um': 0.75, '1-5um': 3.0,
    '5-10um': 7.5, '10-20um': 15.0, '20-40um': 30.0,
}
_BIN_COLUMN_INDEX = {name: i for i, name in enumerate(SIZE_BIN_NAMES)}


def _molar_scale(units):
    """n/u/m prefix -> scale to mol/L. Case-SENSITIVE: 'M' alone (molar, no
    prefix) must not match the lowercase 'm' (milli) check. Covers every
    units string actually in scope (M, mM, uM, nM, and their qualifier-
    suffixed cousins) just by reading the first character."""
    u = units.strip()
    if u.startswith('n'):
        return 1e-9
    if u.startswith('u'):
        return 1e-6
    if u.startswith('m'):
        return 1e-3
    return 1.0


def _float_or_none(s):
    if s in (None, ''):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _load_all():
    """{mission_num: {parcel_idx: [row dict, ...]}}, mission_num in (1, 2).
    Row dicts keep every raw (stripped) spreadsheet field this module uses."""
    data = {1: {}, 2: {}}
    for mission_num in (1, 2):
        for parcel_idx in PARCEL_INDICES:
            path = os.path.join(_DATA_DIR, f"M{mission_num}_Parcel_{parcel_idx}.csv")
            with open(path, encoding="utf-8", errors="replace", newline="") as fh:
                reader = list(csv.reader(fh))
            rows = []
            for r in reader[3:]:
                if len(r) < 19 or not r[2].strip():
                    continue
                rows.append({
                    'parameter': r[0].strip(),
                    'units': r[1].strip(),
                    'instrument': r[2].strip(),
                    'dissolved': r[3].strip(),
                    'bins': [r[4 + i].strip() for i in range(6)],
                    'total_particulate': r[10].strip(),
                    'total_bulk': r[11].strip(),
                    'data_type': r[12].strip(),
                    'injection_volume': r[13].strip(),
                    'injection_volume_units': r[14].strip(),
                    'lod': r[15].strip(),
                    'lod_units': r[16].strip(),
                })
            data[mission_num][parcel_idx] = rows
    return data


# Loaded once per Cloud Functions container (cold start) — every lookup
# below reads from this in-memory copy of the CSVs, never a hardcoded
# number, so re-copying the CSVs and redeploying is the only sync step.
_DATA = _load_all()


def _mission_num(mission):
    if mission in ('HIVE', 1):
        return 1
    if mission in ('WhiteWhale', 2):
        return 2
    raise ValueError(f"Unknown mission: {mission}")


def _is_in_scope(row):
    return row['data_type'] == 'csv' and row['units'] not in EXCLUDED_UNITS


def _rows_for_instrument(mission, instrument, parcel_idx):
    """{parameter: row dict} for this mission/instrument/parcel — in-scope
    rows only, read fresh from _DATA every call."""
    mission_num = _mission_num(mission)
    out = {}
    for row in _DATA[mission_num][parcel_idx]:
        if not _is_in_scope(row):
            continue
        if CSV_INSTRUMENT_TO_WEBSITE.get(row['instrument']) == instrument:
            out[row['parameter']] = row
    return out


def available_parameters(mission, instrument):
    """Every parameter this instrument can report on this mission. Parcel
    0 is just a reference point — every parcel shares the same parameter
    set for a given (mission, instrument), verified against the actual
    spreadsheets."""
    return sorted(_rows_for_instrument(mission, instrument, 0).keys())


def instrument_has_concentration_data(mission, instrument):
    """True if this instrument has any in-scope rows at all on this
    mission — what main.py uses to decide real-report vs. placeholder."""
    return bool(available_parameters(mission, instrument))


def _lod_molar(row):
    """LOD in mol/L. 0.0 (always reportable, never "Tr") if the spreadsheet
    has no usable LOD yet — currently true for 4 GCMS hydrocarbons missing
    LOD data entirely — per explicit instruction to default to 0 until real
    values are filled in, rather than skip those rows."""
    if row['lod_units'] not in _MOLAR_LOD_UNITS:
        return 0.0
    value = _float_or_none(row['lod'])
    return value if value is not None else 0.0


def bulk_report(mission, instrument, x, y, z, sample_volume_l, column='total_bulk'):
    """
    Every concentration-measuring instrument on HIVE (always bulk water —
    no FACS step), and WhiteWhale's "Dissolved Water Fraction" selection
    (column='dissolved' — the truly-dissolved fraction left after FACS has
    already sorted particulates OUT into size bins, NOT the same as
    'total_bulk', which still includes particulates).

    For each parameter this instrument can measure: blends the requested
    column across the parcels weighted for (x, y, z) — see
    sort_particles_flow_cytometer.parcel_blend_weights() — converts to
    mol/L, concentrates the full requested sample_volume_l down to a fixed
    1 mL (calculate_sample_concentration_bulk's own logic), and reports
    either that concentration or "Tr" if it's under the LOD.

    Returns a sorted list of (parameter, value_or_'Tr') tuples.
    """
    weights = parcel_blend_weights(x, y, z)
    rows_by_parcel = {idx: _rows_for_instrument(mission, instrument, idx) for idx in weights}
    concentration_factor = sample_volume_l / 0.001  # concentrated into 1 mL = 0.001 L

    results = []
    for parameter in available_parameters(mission, instrument):
        blended = 0.0
        missing = False
        for parcel_idx, weight in weights.items():
            row = rows_by_parcel[parcel_idx].get(parameter)
            value = _float_or_none(row[column]) if row else None
            if value is None:
                missing = True
                break
            blended += weight * value
        if missing:
            continue

        reference_row = rows_by_parcel[next(iter(weights))][parameter]
        bulk_molar = blended * _molar_scale(reference_row['units'])
        concen_in_sample = bulk_molar * concentration_factor
        lod = _lod_molar(reference_row)
        report = 'Tr' if concen_in_sample < lod else concen_in_sample
        results.append((parameter, report))
    return sorted(results)


def particle_report(mission, instrument, x, y, z, selected_bins, n_particles_by_bin):
    """
    WhiteWhale only, for analyses that do NOT include "Dissolved Water
    Fraction". For each parameter this instrument can measure: blends each
    selected bucket's per-bucket concentration (spreadsheet columns E-J)
    across the weighted parcels for (x, y, z), converts each bucket's
    particle count — n_particles_by_bin, the REAL FACS-sorted counts, used
    exactly as given, never recomputed, so the report stays self-consistent
    with what FACS actually sorted — into a volume of biological material
    via the bucket's median diameter, sums moles across every selected
    bucket, and divides by the instrument's own injection volume
    (spreadsheet column N) to get the reported concentration (mol/L) or
    "Tr" against the LOD.

    selected_bins: sort_particles_flow_cytometer-style bin names (e.g.
    "<0.5um" — SIZE_BIN_NAMES entries), NOT website bin ids and NOT
    "dissolved" (bulk_report handles that case instead).

    Returns a sorted list of (parameter, value_or_'Tr') tuples.
    """
    weights = parcel_blend_weights(x, y, z)
    rows_by_parcel = {idx: _rows_for_instrument(mission, instrument, idx) for idx in weights}

    results = []
    for parameter in available_parameters(mission, instrument):
        reference_row = rows_by_parcel[next(iter(weights))][parameter]
        inj_vol_l = _float_or_none(reference_row['injection_volume'])
        if not inj_vol_l:
            continue
        scale = _molar_scale(reference_row['units'])

        mols_total = 0.0
        missing = False
        for bin_name in selected_bins:
            col_idx = _BIN_COLUMN_INDEX[bin_name]
            blended = 0.0
            for parcel_idx, weight in weights.items():
                row = rows_by_parcel[parcel_idx].get(parameter)
                value = _float_or_none(row['bins'][col_idx]) if row else None
                if value is None:
                    missing = True
                    break
                blended += weight * value
            if missing:
                break

            conc_molar = blended * scale
            n_particles = n_particles_by_bin.get(bin_name, 0)
            radius_m = (BIN_MEDIAN_UM[bin_name] / 2) * 1e-6
            vol_one_particle_l = (4 / 3) * np.pi * (radius_m ** 3) * 1000  # m^3 -> L
            mols_total += vol_one_particle_l * n_particles * conc_molar
        if missing:
            continue

        final_concen = mols_total / inj_vol_l
        lod = _lod_molar(reference_row)
        report = 'Tr' if final_concen < lod else final_concen
        results.append((parameter, report))
    return sorted(results)


def generate_report_rows(mission, instrument, x, y, z, sample_volume_l=None,
                          selected_bins=None, n_particles_by_bin=None):
    """
    Single entry point main.py calls for any concentration-capable
    instrument. HIVE: always bulk_report over the full bulk water.
    WhiteWhale: bulk_report over the dissolved column if "dissolved" is
    anywhere in selected_bins — it floods out any other buckets selected
    alongside it, so those are ignored for this call, per explicit
    instruction ("if bulk water is mixed in with a size bucket, it would
    flood the results of that size bucket anyway"); otherwise
    particle_report over just the selected buckets.
    """
    if mission == 'HIVE':
        return bulk_report(mission, instrument, x, y, z, sample_volume_l, column='total_bulk')

    selected_bins = selected_bins or []
    if 'dissolved' in selected_bins:
        return bulk_report(mission, instrument, x, y, z, sample_volume_l, column='dissolved')

    particle_bins = [b for b in selected_bins if b != 'dissolved']
    return particle_report(mission, instrument, x, y, z, particle_bins, n_particles_by_bin or {})
