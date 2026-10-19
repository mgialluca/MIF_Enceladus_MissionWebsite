"""
generate_parcel_data.py
========================
Synthetic Flow Cytometer / FACS event generator for the Enceladus mission sim.

This is the SOURCE OF TRUTH copy. The website repo keeps an identical copy at
functions/sort_particles_flow_cytometer.py — re-sync that file by hand whenever
this one changes (same manual-sync pattern as the seafloor .npy data).

Rebuilt from generate_parcel_{1,2,4}_data_v2.py (the corrected per-parcel
models — the original generate_parcel_data.py was missing the 10-20um and
20-40um size bins those scripts define) plus the field-noise/debris treatment
from generate_parcel_plots_v3.py, which that script only applied to plots.
Parcel 3 has no dedicated script; it stays a 25%-strength copy of Parcel 4.

Position is no longer a discrete parcel lookup — get_parcel_params() returns a
continuously blended parameter set near every zone boundary (see its
docstring), so there's no visible jump in what a sample contains as a drone
or station crosses from one biochemical zone into the next. NOTE: x, y, z are
all in METRES here (the website's convention everywhere else), not the x/y-in-
km convention the very first version of this module's get_parcel() docstring
used.

Every event carries simulation truth a participant must never see directly:
which parcel/blend it came from, whether it's really a Cell/Vesicle/Debris
particle, and the instrument's own (imperfect, ~8% error) sort decision. Call
player_visible_csv(df) before writing anything a participant will see; the
full df (with those columns) is for backend bookkeeping and downstream
instruments only.
"""

import numpy as np
import pandas as pd

# ── Size bins: name -> (min diameter um, max diameter um) ──────────────────
# Cells have a slightly higher floor than vesicles/debris (0.2 vs 0.1 um) —
# a real cell can't be as small as a bare vesicle or a silt grain.
SIZE_BIN_RANGES_CELL = {
    '<0.5um':  (0.2, 0.45),
    '0.5-1um': (0.5, 0.95),
    '1-5um':   (1.0, 4.5),
    '5-10um':  (5.0, 9.5),
    '10-20um': (10.0, 19.5),
    '20-40um': (20.0, 39.5),
}
SIZE_BIN_RANGES_OTHER = {
    '<0.5um':  (0.1, 0.45),
    '0.5-1um': (0.5, 0.95),
    '1-5um':   (1.0, 4.5),
    '5-10um':  (5.0, 9.5),
    '10-20um': (10.0, 19.5),
    '20-40um': (20.0, 39.5),
}
SIZE_BIN_NAMES = list(SIZE_BIN_RANGES_CELL.keys())

# Baseline cell size distribution — the same in every parcel. Any bin left out
# is 0% at baseline; the noise step in _noisy_bin_counts still gives it a
# small chance of a stray event (see BIN_NOISE_ALPHA_FLOOR below).
CELL_BIN_FRACTIONS = {'<0.5um': 0.09, '0.5-1um': 0.75, '1-5um': 0.15, '5-10um': 0.01}

# ── Parcel definitions ───────────────────────────────────────────────────────
# Concentrations are particles per mL. debris_conc_per_ml models sub-micron
# rock flour / mineral silt a field instrument can't fully screen out; it
# always lands in <0.5um and scales with sample volume like everything else.
PARCELS = {
    0: {  # Surface (0-1 m depth) — dissolved chemistry only, nothing particulate
        'name': 'surface_dissolved_only',
        'cell_conc_per_ml': 0.0,
        'vesicle_conc_per_ml': 0.0,
        'vesicle_bin_fractions': {},
        'debris_conc_per_ml': 0.0,
        'debris_diam_range': (0.1, 0.45),
        'debris_noise': {},
        'debris_nad_range': (2.0, 25.0),
    },
    1: {  # Ice/Water Interface (10 m depth, T = -1.1 C)
        'name': 'ice_water_interface',
        'cell_conc_per_ml': 7.4,
        'vesicle_conc_per_ml': 2.12e8,
        'vesicle_bin_fractions': {
            '<0.5um': 0.9909844, '0.5-1um': 0.005, '1-5um': 0.004,
            '5-10um': 0.000015, '10-20um': 0.0000005, '20-40um': 0.0000001
        },
        'debris_conc_per_ml': 6000.0,
        'debris_diam_range': (0.1, 0.45),
        'debris_noise': {  # channel -> (lognormal median, sigma)
            'FSC_A': (8.0, 0.65), 'SSC_A': (6.0, 0.70),
            'FL1_SYTO9_509nm': (18.0, 0.80), 'FL2_Tryptophan_357nm': (14.0, 0.75)
        },
        'debris_nad_range': (2.0, 28.0),
    },
    2: {  # Bulk Ocean (27 km depth, T = -1.2 C) — clean, no vesicles or debris
        'name': 'bulk_ocean',
        'cell_conc_per_ml': 40.0,
        'vesicle_conc_per_ml': 0.0,
        'vesicle_bin_fractions': {},
        'debris_conc_per_ml': 0.0,
        'debris_diam_range': (0.1, 0.45),
        'debris_noise': {},
        'debris_nad_range': (2.0, 25.0),
    },
    3: {  # Hydrothermal Periphery — placeholder: Parcel 4 at 25% strength
        'name': 'hydrothermal_periphery',
        'cell_conc_per_ml': 25520.0 * 0.25,
        'vesicle_conc_per_ml': 31000.0 * 0.25,
        'vesicle_bin_fractions': {'<0.5um': 0.995, '0.5-1um': 0.005},
        'debris_conc_per_ml': 2500.0 * 0.25,
        'debris_diam_range': (0.1, 0.8),
        'debris_noise': {
            'FSC_A': (15.0, 0.70), 'SSC_A': (12.0, 0.80),
            'FL1_SYTO9_509nm': (25.0, 0.65), 'FL2_Tryptophan_357nm': (30.0, 0.70)
        },
        'debris_nad_range': (2.0, 25.0),
    },
    4: {  # Hydrothermal Hotspot (50 km depth, T = 80 C)
        'name': 'hydrothermal_hotspot',
        'cell_conc_per_ml': 25520.0,
        'vesicle_conc_per_ml': 31000.0,
        'vesicle_bin_fractions': {'<0.5um': 0.995, '0.5-1um': 0.005},
        'debris_conc_per_ml': 2500.0,
        'debris_diam_range': (0.1, 0.8),
        'debris_noise': {
            'FSC_A': (15.0, 0.70), 'SSC_A': (12.0, 0.80),
            'FL1_SYTO9_509nm': (25.0, 0.65), 'FL2_Tryptophan_357nm': (30.0, 0.70)
        },
        'debris_nad_range': (2.0, 25.0),
    },
}

# ── Depth zones (m) ──────────────────────────────────────────────────────────
Z_PARCEL0_END = 1.0          # 0-1 m: Parcel 0
Z_TRANSITION_01_END = 10.0   # 1-10 m: Parcel 0 -> Parcel 1
Z_PARCEL1_END = 20.0         # 10-20 m: Parcel 1
Z_TRANSITION_12_END = 30.0   # 20-30 m: Parcel 1 -> Parcel 2
Z_PARCEL2_END = 45000.0      # 30 m-45 km: Parcel 2
Z_TRANSITION_23_END = 46000.0  # 45-46 km: Parcel 2 -> Parcel 3; 46 km+: Parcel 3

# How sharply every transition band approaches its target (see _ease()).
TRANSITION_STEEPNESS = 3.0

# ── Vent fields ───────────────────────────────────────────────────────────────
# Center (website x,y metres, i.e. CRADLE_7Field_Nonuniform_Canonical_v5.csv's
# field_center_{x,y}_m shifted by -5000 to match the website's centered grid —
# same shift seafloor-model.js applies) plus the two radii (m) that gate
# Parcel 4: inside active_r is full Parcel 4; out to strong_r is an
# exponential decay back toward whatever the depth rule gives at that depth.
# Re-derive these by hand if the vent catalogue changes.
VENT_FIELDS = [
    {'field_id': 1, 'cx': -3750.0, 'cy': -3350.0, 'active_r': 1195.1, 'strong_r': 1418.5},
    {'field_id': 2, 'cx': -450.0,  'cy': -3750.0, 'active_r': 930.6,  'strong_r': 1057.8},
    {'field_id': 3, 'cx': 2900.0,  'cy': -2950.0, 'active_r': 1155.9, 'strong_r': 1395.3},
    {'field_id': 4, 'cx': -2950.0, 'cy': 150.0,   'active_r': 744.5,  'strong_r': 823.8},
    {'field_id': 5, 'cx': 550.0,   'cy': -250.0,  'active_r': 979.6,  'strong_r': 1133.2},
    {'field_id': 6, 'cx': 3300.0,  'cy': 1750.0,  'active_r': 764.1,  'strong_r': 853.1},
    {'field_id': 7, 'cx': -750.0,  'cy': 3550.0,  'active_r': 1126.5, 'strong_r': 1348.5},
]

# File stays bounded regardless of how much water was actually sampled — large
# volumes are downsampled to a representative subset, not generated in full.
TARGET_MAX_EVENTS = 20000

CHANNELS = ['FSC_A', 'SSC_A', 'FL1_SYTO9_509nm', 'FL2_Tryptophan_357nm', 'FL3_NAD+_450nm']

# Columns participants are allowed to see. Parcel identity, true particle type,
# and the instrument's own sort gating are simulation truth meant to be
# discovered through play, not read off a column — see player_visible_csv().
PLAYER_VISIBLE_COLUMNS = [
    'Event_ID', 'Sample_Volume_mL', 'Size_Bin', 'Diameter_um',
    'FSC_A', 'SSC_A', 'FL1_SYTO9_509nm', 'FL2_Tryptophan_357nm', 'FL3_NAD+_450nm'
]

# Bin-split noise: every call perturbs the baseline fractions (Dirichlet) before
# drawing counts (multinomial), so the realized split varies call to call. A
# baseline-0% bin (like 20-40um outside Parcel 1) gets a fixed small alpha
# instead of a scaled-down one — scaling a tiny epsilon by CONCENTRATION makes
# it numerically negligible and a stray event effectively never happens, which
# defeats the point. Raise CONCENTRATION to make the real bins hug their
# baseline more tightly; raise ALPHA_FLOOR to make strays into normally-empty
# bins more common (both at a given sample size — larger samples naturally
# produce more strays either way, since there are more draws to land one).
BIN_NOISE_CONCENTRATION = 800.0
BIN_NOISE_ALPHA_FLOOR = 0.2

# Extra multiplicative channel drift applied to every event on top of its own
# per-event noise, modeling PMT/electronic drift in a field-deployed instrument
# (from generate_parcel_plots_v3.py's add_field_noise_and_drift — originally
# plot-only, now part of the real data per project decision).
FIELD_DRIFT_CV = 0.22
FIELD_DRIFT_CLIP = (1.0, 10000.0)


def _ease(frac):
    """
    Maps 0..1 -> 0..1 with a saturating-exponential shape: fast initial change,
    leveling off near 1. Reads as "rapidly approaching" the target while still
    landing exactly on it at frac=1, so no visible jump happens at a zone
    boundary. The same shape works whether the target value is higher or
    lower than the start — it only describes how fast the blend moves, not
    which direction.
    """
    frac = min(max(frac, 0.0), 1.0)
    return (1 - np.exp(-TRANSITION_STEEPNESS * frac)) / (1 - np.exp(-TRANSITION_STEEPNESS))


def _blend_params(params_a, params_b, frac):
    """Continuously blends two parcels' concentrations and bin fractions —
    frac=0 is pure params_a, frac=1 is pure params_b — eased via _ease()."""
    t = _ease(frac)
    fa = params_a.get('vesicle_bin_fractions', {})
    fb = params_b.get('vesicle_bin_fractions', {})
    blended_fractions = {b: (1 - t) * fa.get(b, 0.0) + t * fb.get(b, 0.0) for b in SIZE_BIN_NAMES}

    # Debris appearance (noise shape, diameter range) isn't a number to blend —
    # use whichever side actually has debris. In every transition this model
    # defines, at most one side ever does.
    shape_source = params_b if params_b['debris_conc_per_ml'] > 0 else params_a

    return {
        'name': f"blend({params_a['name']},{params_b['name']},{t:.2f})",
        'cell_conc_per_ml': (1 - t) * params_a['cell_conc_per_ml'] + t * params_b['cell_conc_per_ml'],
        'vesicle_conc_per_ml': (1 - t) * params_a['vesicle_conc_per_ml'] + t * params_b['vesicle_conc_per_ml'],
        'debris_conc_per_ml': (1 - t) * params_a['debris_conc_per_ml'] + t * params_b['debris_conc_per_ml'],
        'vesicle_bin_fractions': blended_fractions,
        'debris_diam_range': shape_source['debris_diam_range'],
        'debris_noise': shape_source['debris_noise'],
        'debris_nad_range': shape_source['debris_nad_range'],
    }


def get_parcel_params(x, y, z):
    """
    Returns the (possibly blended) parcel parameter dict for position (x, y, z)
    — all in METRES, (0, 0) at the base station, matching every other
    coordinate in this project.

    Depth zones:
      0-1 m        Parcel 0 (surface, dissolved only — no particles at all)
      1-10 m       exponential transition, Parcel 0 -> Parcel 1
      10-20 m      Parcel 1 (Ice/Water Interface)
      20-30 m      exponential transition, Parcel 1 -> Parcel 2
      30 m-45 km   Parcel 2 (Bulk Ocean)
      45-46 km     exponential transition, Parcel 2 -> Parcel 3
      46 km+       Parcel 3 (Hydrothermal Periphery) — unless within a vent
                   field's influence (see below), which pulls it toward
                   Parcel 4 (Hydrothermal Hotspot).

    Vent-field override — only checked at 45 km+, since the fields themselves
    sit at the seafloor; a shallow point directly above one is still just
    whatever the depth rule above says. Within active_r of the NEAREST
    field's center (plain 2D distance — same convention as seafloor.py's own
    zone_at()), full Parcel 4. Out to strong_r, an exponential transition from
    Parcel 4 back to whatever the depth rule gives at that exact depth — so
    at 45.5 km the decay band blends toward that depth's own Parcel 2/3 mix,
    not a hardcoded Parcel 3.
    """
    if z < 0:
        raise ValueError(f"z must be a non-negative depth in m, got {z}")

    if z <= Z_PARCEL0_END:
        return PARCELS[0]
    if z <= Z_TRANSITION_01_END:
        frac = (z - Z_PARCEL0_END) / (Z_TRANSITION_01_END - Z_PARCEL0_END)
        return _blend_params(PARCELS[0], PARCELS[1], frac)
    if z <= Z_PARCEL1_END:
        return PARCELS[1]
    if z <= Z_TRANSITION_12_END:
        frac = (z - Z_PARCEL1_END) / (Z_TRANSITION_12_END - Z_PARCEL1_END)
        return _blend_params(PARCELS[1], PARCELS[2], frac)
    if z <= Z_PARCEL2_END:
        return PARCELS[2]

    if z <= Z_TRANSITION_23_END:
        depth_frac = (z - Z_PARCEL2_END) / (Z_TRANSITION_23_END - Z_PARCEL2_END)
        background = _blend_params(PARCELS[2], PARCELS[3], depth_frac)
    else:
        background = PARCELS[3]

    nearest = min(VENT_FIELDS, key=lambda f: np.hypot(x - f['cx'], y - f['cy']))
    dist = np.hypot(x - nearest['cx'], y - nearest['cy'])
    if dist <= nearest['active_r']:
        return PARCELS[4]
    if dist <= nearest['strong_r']:
        radial_frac = (dist - nearest['active_r']) / (nearest['strong_r'] - nearest['active_r'])
        return _blend_params(PARCELS[4], background, radial_frac)
    return background


def _scaled_count(conc_per_ml, sample_volume_ml, force_min_one=False):
    """round(conc * volume), with an optional floor of 1 — but ONLY when the
    true concentration is actually nonzero. A genuinely-zero concentration
    (Parcel 0, or a 0 mL remainder) must stay exactly 0, not get bumped to a
    phantom 1."""
    n = int(round(conc_per_ml * sample_volume_ml))
    if force_min_one and n == 0 and conc_per_ml > 0:
        n = 1
    return n


def _noisy_bin_counts(rng, n_particles, base_fractions):
    """
    Splits n_particles across SIZE_BIN_NAMES with two layers of randomness:
    a Dirichlet perturbation of the baseline fractions (so the overall split
    drifts call to call), then a multinomial draw of actual counts from that
    perturbed split. A baseline-0% bin gets a fixed alpha (BIN_NOISE_ALPHA_FLOOR)
    rather than a scaled-down fraction, so it keeps a small, real chance of a
    stray count instead of being perturbed into numerical nonexistence.
    """
    if n_particles <= 0:
        return {b: 0 for b in SIZE_BIN_NAMES}
    alpha = np.array([
        base_fractions.get(b, 0.0) * BIN_NOISE_CONCENTRATION
        if base_fractions.get(b, 0.0) > 0 else BIN_NOISE_ALPHA_FLOOR
        for b in SIZE_BIN_NAMES
    ])
    noisy = rng.dirichlet(alpha)
    counts = rng.multinomial(n_particles, noisy)
    return dict(zip(SIZE_BIN_NAMES, counts))


def _apply_field_drift(rng, values):
    """Extra multiplicative channel drift, layered on top of an event's own noise."""
    lo, hi = FIELD_DRIFT_CLIP
    for ch in CHANNELS:
        values[ch] = float(np.clip(values[ch] * rng.lognormal(0, FIELD_DRIFT_CV), lo, hi))
    return values


def _make_cell_event(rng, diam):
    fsc = (diam ** 2) * 80.0 * rng.lognormal(0, 0.12)
    ssc = (diam ** 1.8) * 45.0 * rng.lognormal(0, 0.15)
    syto9 = 350.0 * (diam ** 1.5) * rng.lognormal(0, 0.12)
    tryp = 150.0 * (diam ** 1.2) * rng.lognormal(0, 0.12)
    nad = 120.0 * (diam ** 1.3) * rng.lognormal(0, 0.10)

    # ~8% baked-in misclassification — the instrument's own imperfect call,
    # distinct from the true Particle_Type.
    if rng.random() > 0.08:
        gate, decision, dest = 'Gate_1_Biotic_Life', 'Deflected_Droplet', 'Tube_1_Biotic_Collection'
    else:
        gate, decision, dest = 'Gate_2_Abiotic_Organics', 'Deflected_Droplet', 'Tube_2_Abiotic_Collection'

    return {
        'FSC_A': fsc, 'SSC_A': ssc, 'FL1_SYTO9_509nm': syto9,
        'FL2_Tryptophan_357nm': tryp, 'FL3_NAD+_450nm': nad,
        'Sort_Gate': gate, 'Sort_Decision': decision, 'Target_Destination': dest
    }


def _make_vesicle_event(rng, diam):
    fsc = (diam ** 2) * 60.0 * rng.lognormal(0, 0.15)
    ssc = (diam ** 1.8) * 35.0 * rng.lognormal(0, 0.18)
    syto9 = 150.0 * (diam ** 1.2) * rng.lognormal(0, 0.20) if rng.random() < 0.4 else rng.uniform(5, 30)
    tryp = 100.0 * (diam ** 1.1) * rng.lognormal(0, 0.20) if rng.random() < 0.3 else rng.uniform(5, 25)
    nad = rng.uniform(5, 25)  # dark noise baseline only

    if nad > 30 and rng.random() < 0.05:
        gate, decision, dest = 'Gate_1_Biotic_Life', 'Deflected_Droplet', 'Tube_1_Biotic_Collection'
    elif syto9 > 80 or tryp > 60:
        gate, decision, dest = 'Gate_2_Abiotic_Organics', 'Deflected_Droplet', 'Tube_2_Abiotic_Collection'
    else:
        gate, decision, dest = 'Ungated_Background', 'Not_Selected', 'Waste_Tank'

    return {
        'FSC_A': fsc, 'SSC_A': ssc, 'FL1_SYTO9_509nm': syto9,
        'FL2_Tryptophan_357nm': tryp, 'FL3_NAD+_450nm': nad,
        'Sort_Gate': gate, 'Sort_Decision': decision, 'Target_Destination': dest
    }


def _make_debris_event(rng, params):
    """Sub-micron rock flour / mineral silt — real but not biological, and not
    a vesicle either. Always in the <0.5um bin (that's what makes it sub-micron
    debris); its own optical signature is pure noise, never spread by the
    bin-split noise that applies to cells and vesicles."""
    values = {}
    for ch, (median, sigma) in params['debris_noise'].items():
        values[ch] = rng.lognormal(np.log(median), sigma)
    lo, hi = params['debris_nad_range']
    values['FL3_NAD+_450nm'] = rng.uniform(lo, hi)
    values.update(Sort_Gate='Ungated_Background', Sort_Decision='Not_Selected', Target_Destination='Waste_Tank')
    return values


def generate_parcel_data(x, y, z, sample_volume_ml=1.0, rng=None):
    """
    Generates synthetic Flow Cytometry/FACS event data for the (possibly
    blended) parcel at (x, y, z) — see get_parcel_params(). This is the
    Flow Cytometer's per-event spreadsheet: always called at a small, fixed
    volume (the first 1 mL of a sample) in practice, and capped at
    TARGET_MAX_EVENTS regardless. For a bin-total-only reading at an
    arbitrary (possibly large) volume, use uncapped_bin_totals() instead.

    Returns a DataFrame with every column, INCLUDING hidden simulation truth
    (Parcel, Particle_Type, Sort_Gate, Sort_Decision, Target_Destination).
    Call player_visible_csv(df) before writing anything a participant will see.

    rng: an optional np.random.Generator, for reproducible tests. Defaults to a
    fresh, unseeded Generator every call, so results vary run to run as they
    should for a live game — never reuse one fixed seed across real requests.
    """
    if rng is None:
        rng = np.random.default_rng()

    p = get_parcel_params(x, y, z)

    n_cells = _scaled_count(p['cell_conc_per_ml'], sample_volume_ml, force_min_one=True)
    n_vesicles = _scaled_count(p['vesicle_conc_per_ml'], sample_volume_ml)
    n_debris = _scaled_count(p['debris_conc_per_ml'], sample_volume_ml)

    # Downsample all three pools together so the file stays bounded no matter
    # how large the requested volume is — this applies even to cell-only
    # positions (Parcel 2 has no vesicles or debris, but a large enough volume
    # still needs its cell count capped).
    total = n_cells + n_vesicles + n_debris
    if total > TARGET_MAX_EVENTS:
        scale = TARGET_MAX_EVENTS / total
        n_cells = max(1, int(round(n_cells * scale))) if n_cells > 0 else 0
        n_vesicles = int(round(n_vesicles * scale))
        n_debris = max(0, TARGET_MAX_EVENTS - n_cells - n_vesicles)

    cell_counts = _noisy_bin_counts(rng, n_cells, CELL_BIN_FRACTIONS)
    vesicle_counts = _noisy_bin_counts(rng, n_vesicles, p['vesicle_bin_fractions'])

    records = []

    for bname, count in cell_counts.items():
        lo, hi = SIZE_BIN_RANGES_CELL[bname]
        for _ in range(int(count)):
            diam = rng.uniform(lo, hi)
            values = _apply_field_drift(rng, _make_cell_event(rng, diam))
            records.append({'Parcel': p['name'], 'Particle_Type': 'Cell', 'Size_Bin': bname,
                             'Diameter_um': round(diam, 3), **values})

    for bname, count in vesicle_counts.items():
        lo, hi = SIZE_BIN_RANGES_OTHER[bname]
        for _ in range(int(count)):
            diam = rng.uniform(lo, hi)
            values = _apply_field_drift(rng, _make_vesicle_event(rng, diam))
            records.append({'Parcel': p['name'], 'Particle_Type': 'Vesicle', 'Size_Bin': bname,
                             'Diameter_um': round(diam, 3), **values})

    lo, hi = p['debris_diam_range']
    for _ in range(int(n_debris)):
        diam = rng.uniform(lo, hi)
        values = _apply_field_drift(rng, _make_debris_event(rng, p))
        records.append({'Parcel': p['name'], 'Particle_Type': 'Debris', 'Size_Bin': '<0.5um',
                         'Diameter_um': round(diam, 3), **values})

    df = pd.DataFrame(records, columns=['Parcel', 'Particle_Type', 'Size_Bin', 'Diameter_um'] + CHANNELS
                       + ['Sort_Gate', 'Sort_Decision', 'Target_Destination'])
    df.insert(0, 'Event_ID', np.arange(1, len(df) + 1))
    df.insert(1, 'Sample_Volume_mL', sample_volume_ml)
    if len(df):
        df[CHANNELS] = df[CHANNELS].round(2)
    return df


def uncapped_bin_totals(x, y, z, sample_volume_ml, rng=None):
    """
    Total particle count per size bin (Cell + Vesicle + Debris combined — the
    number participants see) for `sample_volume_ml` at (x, y, z). This is the
    FACS reading: unlike generate_parcel_data, there is NO event cap, since no
    per-event rows are created, just totals — however large the true count is.
    sample_volume_ml may be 0 (e.g. a 1 mL request has no FACS remainder),
    which correctly returns all zeros.
    """
    if rng is None:
        rng = np.random.default_rng()
    if sample_volume_ml <= 0:
        return {b: 0 for b in SIZE_BIN_NAMES}

    p = get_parcel_params(x, y, z)
    n_cells = _scaled_count(p['cell_conc_per_ml'], sample_volume_ml, force_min_one=True)
    n_vesicles = _scaled_count(p['vesicle_conc_per_ml'], sample_volume_ml)
    n_debris = _scaled_count(p['debris_conc_per_ml'], sample_volume_ml)

    cell_counts = _noisy_bin_counts(rng, n_cells, CELL_BIN_FRACTIONS)
    vesicle_counts = _noisy_bin_counts(rng, n_vesicles, p['vesicle_bin_fractions'])

    totals = {b: int(cell_counts.get(b, 0)) + int(vesicle_counts.get(b, 0)) for b in SIZE_BIN_NAMES}
    totals['<0.5um'] += int(n_debris)
    return totals


def player_visible_csv(df):
    """Drops every column that would leak simulation truth — parcel identity,
    true particle type, and the instrument's own sort gating — before a
    DataFrame is written anywhere a participant will see it."""
    return df[PLAYER_VISIBLE_COLUMNS]


def size_bin_totals(df):
    """Total particle count per size bin — Cells + Vesicles + Debris, the
    number participants see. A real instrument can't perfectly separate silt
    from a true signal, so debris counts toward the total like anything else."""
    counts = df['Size_Bin'].value_counts()
    return {b: int(counts.get(b, 0)) for b in SIZE_BIN_NAMES}


def hidden_particle_breakdown(df):
    """Cell/Vesicle/Debris counts per size bin, for downstream instruments.
    Never shown to participants."""
    breakdown = df.groupby(['Size_Bin', 'Particle_Type']).size().unstack(fill_value=0)
    return breakdown.reindex(SIZE_BIN_NAMES, fill_value=0)


if __name__ == '__main__':
    # A few representative depths (m), at x=y=0 (clear of every vent field).
    examples = {
        'parcel0_surface': (0.0, 0.0, 0.5),
        'transition_0to1': (0.0, 0.0, 5.0),
        'parcel1_interface': (0.0, 0.0, 15.0),
        'transition_1to2': (0.0, 0.0, 25.0),
        'parcel2_bulk_ocean': (0.0, 0.0, 27000.0),
        # (0,0) sits only ~600 m from vent field 5's center — clear of every
        # field at (4900, 4900) instead, so these two actually show the plain
        # depth-based transition/periphery rather than a vent-influenced read.
        'transition_2to3': (4900.0, 4900.0, 45500.0),
        'parcel3_periphery': (4900.0, 4900.0, 48000.0),
        'parcel4_hotspot': (-3750.0, -3350.0, 48000.0),  # at vent field 1's center
    }
    for label, (x, y, z) in examples.items():
        df = generate_parcel_data(x, y, z, sample_volume_ml=1.0)
        fname = f"{label}_synthetic.csv"
        df.to_csv(fname, index=False)
        print(f"Successfully generated {fname} ({len(df)} events)")
