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
# small chance of a stray event (see BIN_NOISE_STRAY_MEAN below).
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

# ── Vents ─────────────────────────────────────────────────────────────────────
# Parcel 4 is a tight envelope around each actual vent chimney, not the whole
# ~1km field footprint (that field-level active_field_radius_m/
# strong_influence_radius_m are a different, much larger scale, used
# elsewhere for e.g. the field's overall thermal-detectability radius — they
# are NOT the right numbers for "am I at a hydrothermal vent"). Within
# VENT_CORE_RADIUS_M of the nearest vent's own 3D structure, full Parcel 4; out
# to VENT_TRANSITION_RADIUS_M, an exponential decay back toward whatever the
# depth rule gives. Distance is true 3D distance to the vent's vertical
# chimney segment (from the seafloor at z_base up to the chimney top at
# z_top = z_base - vent_height_m) — NOT horizontal-only — so a point directly
# above a vent but thousands of metres shallower than its actual structure
# does not count as Parcel 4.
#
# x, y: website metres (CRADLE_7Field_Nonuniform_Canonical_v5.csv's x_m/y_m
# shifted by -5000, same convention as seafloor-model.js). z_top, z_base:
# precomputed from that same catalogue's vent_height_m against the real
# terrain model (assets/seafloor/seafloor_*.npy) — every vent here lands
# between ~47.7-49.4 km, well below the 45-46 km Parcel 2/3 transition, so it
# never interacts with that depth band. Re-derive by hand (bilinear-sample
# the terrain at each vent's x,y, subtract vent_height_m for z_top) if either
# the terrain or the vent catalogue changes.
VENT_CORE_RADIUS_M = 10.0
VENT_TRANSITION_RADIUS_M = 100.0

VENTS = [
    {'field_id': 1, 'vent_id': 1, 'x': -4112.5, 'y': -3055.8, 'z_top': 48189.0, 'z_base': 48987.9},
    {'field_id': 1, 'vent_id': 2, 'x': -3245.5, 'y': -3209.0, 'z_top': 48194.2, 'z_base': 48992.3},
    {'field_id': 1, 'vent_id': 3, 'x': -3957.7, 'y': -3591.7, 'z_top': 48007.2, 'z_base': 48854.8},
    {'field_id': 1, 'vent_id': 4, 'x': -3913.1, 'y': -3490.2, 'z_top': 48161.8, 'z_base': 48914.3},
    {'field_id': 1, 'vent_id': 5, 'x': -3412.1, 'y': -3269.9, 'z_top': 48286.4, 'z_base': 49009.9},
    {'field_id': 1, 'vent_id': 6, 'x': -3524.8, 'y': -3175.2, 'z_top': 47763.6, 'z_base': 48743.8},
    {'field_id': 1, 'vent_id': 7, 'x': -3765.7, 'y': -3449.5, 'z_top': 48077.6, 'z_base': 48891.8},
    {'field_id': 2, 'vent_id': 1, 'x': -130.9,  'y': -3524.3, 'z_top': 48652.2, 'z_base': 49243.5},
    {'field_id': 2, 'vent_id': 2, 'x': -333.0,  'y': -3611.7, 'z_top': 48575.8, 'z_base': 49186.6},
    {'field_id': 2, 'vent_id': 3, 'x': -279.0,  'y': -3764.1, 'z_top': 48189.5, 'z_base': 48993.2},
    {'field_id': 2, 'vent_id': 4, 'x': -690.6,  'y': -3440.7, 'z_top': 48741.9, 'z_base': 49282.5},
    {'field_id': 2, 'vent_id': 5, 'x': -756.8,  'y': -4011.1, 'z_top': 48493.8, 'z_base': 49160.4},
    {'field_id': 3, 'vent_id': 1, 'x': 2675.5,  'y': -3006.5, 'z_top': 48174.4, 'z_base': 48973.3},
    {'field_id': 3, 'vent_id': 2, 'x': 3123.1,  'y': -2827.6, 'z_top': 47752.7, 'z_base': 48724.2},
    {'field_id': 3, 'vent_id': 3, 'x': 2921.7,  'y': -3418.3, 'z_top': 47808.4, 'z_base': 48641.0},
    {'field_id': 3, 'vent_id': 4, 'x': 3026.2,  'y': -2863.9, 'z_top': 48386.2, 'z_base': 49017.4},
    {'field_id': 3, 'vent_id': 5, 'x': 2796.5,  'y': -3353.7, 'z_top': 48287.9, 'z_base': 49046.7},
    {'field_id': 3, 'vent_id': 6, 'x': 2898.9,  'y': -2440.5, 'z_top': 47873.8, 'z_base': 48841.2},
    {'field_id': 3, 'vent_id': 7, 'x': 2922.5,  'y': -3485.3, 'z_top': 47712.8, 'z_base': 48621.5},
    {'field_id': 4, 'vent_id': 1, 'x': -2668.9, 'y': 6.3,     'z_top': 48878.7, 'z_base': 49369.5},
    {'field_id': 4, 'vent_id': 2, 'x': -2839.1, 'y': 289.3,   'z_top': 48878.8, 'z_base': 49364.4},
    {'field_id': 4, 'vent_id': 3, 'x': -3239.8, 'y': 66.2,    'z_top': 48677.5, 'z_base': 49271.8},
    {'field_id': 5, 'vent_id': 1, 'x': 166.9,   'y': -448.6,  'z_top': 48660.1, 'z_base': 49253.6},
    {'field_id': 5, 'vent_id': 2, 'x': 858.2,   'y': -286.7,  'z_top': 48468.7, 'z_base': 49144.3},
    {'field_id': 5, 'vent_id': 3, 'x': 276.7,   'y': -613.6,  'z_top': 48418.4, 'z_base': 48944.1},
    {'field_id': 5, 'vent_id': 4, 'x': 311.8,   'y': -597.1,  'z_top': 48415.4, 'z_base': 48938.6},
    {'field_id': 5, 'vent_id': 5, 'x': 652.5,   'y': -268.3,  'z_top': 48699.8, 'z_base': 49247.7},
    {'field_id': 6, 'vent_id': 1, 'x': 3094.6,  'y': 1676.6,  'z_top': 48884.7, 'z_base': 49372.4},
    {'field_id': 6, 'vent_id': 2, 'x': 3328.7,  'y': 1923.3,  'z_top': 48845.2, 'z_base': 49342.8},
    {'field_id': 6, 'vent_id': 3, 'x': 3497.6,  'y': 1640.1,  'z_top': 48978.9, 'z_base': 49416.0},
    {'field_id': 7, 'vent_id': 1, 'x': -892.4,  'y': 3141.7,  'z_top': 47923.1, 'z_base': 48867.0},
    {'field_id': 7, 'vent_id': 2, 'x': -914.6,  'y': 3782.4,  'z_top': 48331.4, 'z_base': 49057.1},
    {'field_id': 7, 'vent_id': 3, 'x': -988.1,  'y': 3437.1,  'z_top': 47917.3, 'z_base': 48843.8},
    {'field_id': 7, 'vent_id': 4, 'x': -483.1,  'y': 3528.0,  'z_top': 48087.8, 'z_base': 48938.6},
    {'field_id': 7, 'vent_id': 5, 'x': -291.3,  'y': 3387.2,  'z_top': 48315.9, 'z_base': 49077.0},
    {'field_id': 7, 'vent_id': 6, 'x': -847.0,  'y': 3480.2,  'z_top': 48024.3, 'z_base': 48890.4},
]


def _nearest_vent_distance_m(x, y, z):
    """True 3D distance from (x, y, z) to the nearest vent's vertical chimney
    segment (x, y, between z_top and z_base) across all VENTS."""
    best = float('inf')
    for v in VENTS:
        horiz = np.hypot(x - v['x'], y - v['y'])
        if z < v['z_top']:
            vert = v['z_top'] - z
        elif z > v['z_base']:
            vert = z - v['z_base']
        else:
            vert = 0.0
        dist = np.hypot(horiz, vert)
        if dist < best:
            best = dist
    return best

# File stays bounded regardless of how much water was actually sampled — large
# volumes are downsampled to a representative subset, not generated in full.
TARGET_MAX_EVENTS = 20000

CHANNELS = ['FSC_A', 'SSC_A', 'FL1_SYTO9_509nm', 'FL2_Tryptophan_357nm', 'FL3_NAD+_450nm']

# Columns participants are allowed to see. Parcel identity, true particle type,
# and the instrument's own sort gating are simulation truth meant to be
# discovered through play, not read off a column — see player_visible_csv().
# Sample_Volume_mL isn't a column — the Flow Cytometer always runs at exactly
# 1 mL, and that's already in the file's "#"-comment header.
PLAYER_VISIBLE_COLUMNS = [
    'Event_ID', 'Size_Bin', 'Diameter_um',
    'FSC_A', 'SSC_A', 'FL1_SYTO9_509nm', 'FL2_Tryptophan_357nm', 'FL3_NAD+_450nm'
]

# Bin-split noise: every call perturbs the baseline fractions (Dirichlet) before
# drawing counts (multinomial), so the realized split among the bins that
# actually have a nonzero baseline varies call to call. Raise CONCENTRATION to
# make those real bins hug their baseline more tightly.
BIN_NOISE_CONCENTRATION = 800.0

# A baseline-0% bin (like 20-40um outside Parcel 1) gets a SEPARATE, small
# Poisson-distributed stray count with this fixed mean — deliberately NOT
# scaled by n_particles. An earlier design folded empty bins into the same
# Dirichlet/multinomial draw as the real bins via a fixed alpha floor, which
# gives every empty bin a constant MEAN FRACTION of the total population
# (~0.025% at the tuning used here) regardless of sample size. That looked
# fine for small, low-concentration samples, but Parcel 4's concentrations are
# enormous (~31,000 vesicles/mL + ~25,520 cells/mL) — at 1 L that's ~59
# million real particles, and 0.025% of that is tens of thousands of "stray"
# events, not the occasional handful the noise was meant to model. A stray
# count that stays a small, roughly-constant handful no matter how large the
# real population is matches the intent: rare instrument misclassification,
# not a rate that scales with the sample.
BIN_NOISE_STRAY_MEAN = 1.5  # cells and vesicles each draw independently and sum, so a bin's realized stray count averages ~2x this

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

    Depth zones (the "background" — what you'd get with no vent nearby):
      0-1 m        Parcel 0 (surface, dissolved only — no particles at all)
      1-10 m       exponential transition, Parcel 0 -> Parcel 1
      10-20 m      Parcel 1 (Ice/Water Interface)
      20-30 m      exponential transition, Parcel 1 -> Parcel 2
      30 m-45 km   Parcel 2 (Bulk Ocean)
      45-46 km     exponential transition, Parcel 2 -> Parcel 3
      46 km+       Parcel 3 (Hydrothermal Periphery)

    Vent override — checked at every depth (not just 45 km+), using true 3D
    distance to the nearest vent's own chimney structure (see VENTS /
    _nearest_vent_distance_m), not horizontal distance to a field center.
    Within VENT_CORE_RADIUS_M of a vent, full Parcel 4 (Hydrothermal Hotspot).
    Out to VENT_TRANSITION_RADIUS_M, an exponential transition from Parcel 4
    back to the background above — so right at the edge of that band, the
    blend lands on that depth's own background mix, not a hardcoded Parcel 3.
    Every real vent sits well below 46 km, so in practice this only ever
    fires near the seafloor; it's depth-independent on principle so a point
    thousands of metres above a vent is never mistaken for Parcel 4.
    """
    if z < 0:
        raise ValueError(f"z must be a non-negative depth in m, got {z}")

    if z <= Z_PARCEL0_END:
        background = PARCELS[0]
    elif z <= Z_TRANSITION_01_END:
        frac = (z - Z_PARCEL0_END) / (Z_TRANSITION_01_END - Z_PARCEL0_END)
        background = _blend_params(PARCELS[0], PARCELS[1], frac)
    elif z <= Z_PARCEL1_END:
        background = PARCELS[1]
    elif z <= Z_TRANSITION_12_END:
        frac = (z - Z_PARCEL1_END) / (Z_TRANSITION_12_END - Z_PARCEL1_END)
        background = _blend_params(PARCELS[1], PARCELS[2], frac)
    elif z <= Z_PARCEL2_END:
        background = PARCELS[2]
    elif z <= Z_TRANSITION_23_END:
        frac = (z - Z_PARCEL2_END) / (Z_TRANSITION_23_END - Z_PARCEL2_END)
        background = _blend_params(PARCELS[2], PARCELS[3], frac)
    else:
        background = PARCELS[3]

    dist = _nearest_vent_distance_m(x, y, z)
    if dist <= VENT_CORE_RADIUS_M:
        return PARCELS[4]
    if dist <= VENT_TRANSITION_RADIUS_M:
        radial_frac = (dist - VENT_CORE_RADIUS_M) / (VENT_TRANSITION_RADIUS_M - VENT_CORE_RADIUS_M)
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
    Splits n_particles across the bins that actually have a nonzero baseline
    fraction (a Dirichlet perturbation of those fractions, then a multinomial
    draw, so the realized split drifts call to call but always sums to
    n_particles), then adds a small, independent Poisson-distributed stray
    count (mean BIN_NOISE_STRAY_MEAN) to every bin that is at 0% baseline —
    extra artifact events on top, not a slice of the real population. The
    stray mean does NOT scale with n_particles; see BIN_NOISE_STRAY_MEAN for
    why a scaled approach breaks down at Parcel 4's concentrations.

    n_particles == 0 means there is no real population in this category at
    all (e.g. Parcel 0, or vesicles outside Parcel 1/3/4) — stays all-zero,
    no stray events either, matching "no particles at all" for that parcel.
    """
    counts = {b: 0 for b in SIZE_BIN_NAMES}
    if n_particles <= 0:
        return counts

    real_bins = [b for b in SIZE_BIN_NAMES if base_fractions.get(b, 0.0) > 0]
    if real_bins:
        alpha = np.array([base_fractions[b] * BIN_NOISE_CONCENTRATION for b in real_bins])
        noisy = rng.dirichlet(alpha)
        real_counts = rng.multinomial(n_particles, noisy)
        for b, c in zip(real_bins, real_counts):
            counts[b] = int(c)

    for b in SIZE_BIN_NAMES:
        if b not in real_bins:
            counts[b] = int(rng.poisson(BIN_NOISE_STRAY_MEAN))

    return counts


def _fair_allocate(true_counts, budget):
    """
    Distributes `budget` events across the bins in `true_counts` (bin -> true
    count) so an abundant bin can't crowd out a rare one. A bin whose true
    count already fits within an equal share of the budget still remaining
    keeps every one of its events; whatever's left over after guaranteeing
    that is split proportionally among the bins still over their share. This
    runs in rounds because protecting one small bin raises the share left for
    the others, which can let another, slightly bigger bin qualify too.

    Returns bin -> allocated count, summing to min(sum(true_counts), budget).
    Without this, a single overwhelmingly common bin (e.g. sub-micron
    vesicles at ~99% of a population) would round every rarer bin down to
    zero under a flat proportional scale-down, even though it has plenty of
    real events of its own to show.
    """
    total_true = sum(true_counts.values())
    if total_true <= budget:
        return dict(true_counts)

    remaining = dict(true_counts)
    allocated = {}
    remaining_budget = budget

    while remaining:
        fair_share = remaining_budget / len(remaining)
        small = {b: c for b, c in remaining.items() if c <= fair_share}
        if not small:
            break
        for b, c in small.items():
            allocated[b] = c
            remaining_budget -= c
            del remaining[b]

    big_total = sum(remaining.values())
    for b, c in remaining.items():
        allocated[b] = int(round(c / big_total * remaining_budget)) if big_total > 0 else 0

    return allocated


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

    n_cells_true = _scaled_count(p['cell_conc_per_ml'], sample_volume_ml, force_min_one=True)
    n_vesicles_true = _scaled_count(p['vesicle_conc_per_ml'], sample_volume_ml)
    n_debris_true = _scaled_count(p['debris_conc_per_ml'], sample_volume_ml)

    # The TRUE split, per bin, before any capping — debris is always <0.5um.
    cell_counts_true = _noisy_bin_counts(rng, n_cells_true, CELL_BIN_FRACTIONS)
    vesicle_counts_true = _noisy_bin_counts(rng, n_vesicles_true, p['vesicle_bin_fractions'])
    debris_counts_true = {b: 0 for b in SIZE_BIN_NAMES}
    debris_counts_true['<0.5um'] = n_debris_true

    true_bin_totals = {
        b: cell_counts_true[b] + vesicle_counts_true[b] + debris_counts_true[b]
        for b in SIZE_BIN_NAMES
    }

    # Cap the TOTAL event count fairly across bins (see _fair_allocate) rather
    # than scaling the cell/vesicle/debris pools as flat percentages of each
    # other — a bin that's genuinely rare (even just e.g. 100 true events)
    # keeps every one of them instead of being rounded away by a bin that's
    # orders of magnitude more abundant (sub-micron vesicles routinely are).
    allocated = _fair_allocate(true_bin_totals, TARGET_MAX_EVENTS)

    records = []
    for bname in SIZE_BIN_NAMES:
        true_total = true_bin_totals[bname]
        ratio = (allocated.get(bname, 0) / true_total) if true_total > 0 else 0.0

        n_cell_out = int(round(cell_counts_true[bname] * ratio))
        lo, hi = SIZE_BIN_RANGES_CELL[bname]
        for _ in range(n_cell_out):
            diam = rng.uniform(lo, hi)
            values = _apply_field_drift(rng, _make_cell_event(rng, diam))
            records.append({'Parcel': p['name'], 'Particle_Type': 'Cell', 'Size_Bin': bname,
                             'Diameter_um': round(diam, 3), **values})

        n_vesicle_out = int(round(vesicle_counts_true[bname] * ratio))
        lo, hi = SIZE_BIN_RANGES_OTHER[bname]
        for _ in range(n_vesicle_out):
            diam = rng.uniform(lo, hi)
            values = _apply_field_drift(rng, _make_vesicle_event(rng, diam))
            records.append({'Parcel': p['name'], 'Particle_Type': 'Vesicle', 'Size_Bin': bname,
                             'Diameter_um': round(diam, 3), **values})

        if bname == '<0.5um':
            n_debris_out = int(round(debris_counts_true[bname] * ratio))
            lo, hi = p['debris_diam_range']
            for _ in range(n_debris_out):
                diam = rng.uniform(lo, hi)
                values = _apply_field_drift(rng, _make_debris_event(rng, p))
                records.append({'Parcel': p['name'], 'Particle_Type': 'Debris', 'Size_Bin': bname,
                                 'Diameter_um': round(diam, 3), **values})

    df = pd.DataFrame(records, columns=['Parcel', 'Particle_Type', 'Size_Bin', 'Diameter_um'] + CHANNELS
                       + ['Sort_Gate', 'Sort_Decision', 'Target_Destination'])
    if len(df):
        # Shuffle so rows aren't visibly grouped bin-by-bin, type-by-type —
        # a real instrument wouldn't hand events back in that order.
        df = df.iloc[rng.permutation(len(df))].reset_index(drop=True)
        df[CHANNELS] = df[CHANNELS].round(2)
    df.insert(0, 'Event_ID', np.arange(1, len(df) + 1))
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
    # A few representative depths (m). (0,0) is ~790 m in 3D from the nearest
    # actual vent (see VENTS) — outside even the 100 m transition band — so
    # it cleanly shows the plain depth-based zones with no vent influence.
    # parcel4_hotspot uses an actual vent's own (x, y) and the midpoint of its
    # chimney's [z_top, z_base] range, since Parcel 4 is now a tight 3D
    # envelope around each vent, not a ~1km field-level radius.
    #
    # Every "transitionX_to_Y" example below sits at the depth/distance where
    # _ease() actually returns 0.5, NOT the arithmetic midpoint of the zone —
    # _ease is front-loaded (steepness=3), so the literal midpoint is already
    # ~82% of the way to the target parcel and barely reads as a blend at all.
    # Solving _ease(frac) = 0.5 gives frac = 0.21485 of the way through
    # whichever zone (depth band, or the 10-100m vent radial band).
    _v = VENTS[0]
    _mid_z = (_v['z_top'] + _v['z_base']) / 2
    examples = {
        'parcel0_surface': (0.0, 0.0, 0.5),
        'transition_0to1': (0.0, 0.0, 2.934),      # z in [1, 10]
        'parcel1_interface': (0.0, 0.0, 15.0),
        'transition_1to2': (0.0, 0.0, 22.149),     # z in [20, 30]
        'parcel2_bulk_ocean': (0.0, 0.0, 27000.0),
        'transition_2to3': (4900.0, 4900.0, 45214.853),  # z in [45000, 46000]
        'parcel3_periphery': (4900.0, 4900.0, 48000.0),
        # Horizontal offset from a real vent's own (x,y), AT its mid-chimney
        # depth (so the vertical component of the 3D distance is 0) — a 3D
        # distance of ~29.34m from the vent, i.e. 0.21485 of the way through
        # the 10-100m VENT_CORE_RADIUS_M/VENT_TRANSITION_RADIUS_M band. This
        # is the Parcel 3<->4 "transition" — radial distance from a vent, not
        # depth, so there's no depth-based transition_3to4 to speak of.
        'transition_3to4_vent': (_v['x'] + 29.337, _v['y'], _mid_z),
        'parcel4_hotspot': (_v['x'], _v['y'], _mid_z),
    }
    for label, (x, y, z) in examples.items():
        df = generate_parcel_data(x, y, z, sample_volume_ml=1.0)
        fname = f"{label}_synthetic.csv"
        df.to_csv(fname, index=False)
        print(f"Successfully generated {fname} ({len(df)} events)")
