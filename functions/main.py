# # Welcome to Cloud Functions for Firebase for Python!
# # To get started, simply uncomment the below code or create your own.
# # Deploy with `firebase deploy`

# from firebase_functions import https_fn
# from firebase_functions.options import set_global_options
# from firebase_admin import initialize_app

# # For cost control, you can set the maximum number of containers that can be
# # running at the same time. This helps mitigate the impact of unexpected
# # traffic spikes by instead downgrading performance. This limit is a per-function
# # limit. You can override the limit for each function using the max_instances
# # parameter in the decorator, e.g. @https_fn.on_request(max_instances=5).
# set_global_options(max_instances=10)

# # initialize_app()
# #
# #
# # @https_fn.on_request()
# # def on_request_example(req: https_fn.Request) -> https_fn.Response:
# #     return https_fn.Response("Hello world!")

import io
import csv
import json
from datetime import datetime, timezone
from firebase_functions import https_fn, options
from firebase_admin import initialize_app, firestore
import google.auth
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

initialize_app()

# Drive folder IDs per group — paste in the real IDs from Step 2A.
GROUP_DRIVE_FOLDERS = {
    "HIVE": "1t5C7viVVWv7gAUc8p5PdAdKtjw-ABK7D",
    "WhiteWhale": "1DqkT7cZ_ONiMgpL4GEPwoGJ_wPBwT-4f",
}


def generate_placeholder_csv(x, y, z):
    """Placeholder data generator. Replace later with the real science model.
    For now: returns a CSV containing just the box's coordinates."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["x", "y", "z"])
    writer.writerow([x, y, z])
    return buffer.getvalue()


def get_next_version_suffix(group, box_id):
    """Uses Firestore as an atomic counter so repeated visits to the same box
    get _V2, _V3, etc. First visit has no suffix."""
    db = firestore.client()
    doc_ref = db.collection("groups").document(group).collection("boxVisits").document(box_id)

    @firestore.transactional
    def update_in_transaction(transaction):
        snapshot = doc_ref.get(transaction=transaction)
        current_count = snapshot.get("visitCount") if snapshot.exists else 0
        new_count = current_count + 1
        transaction.set(doc_ref, {"visitCount": new_count}, merge=True)
        return new_count

    transaction = db.transaction()
    return update_in_transaction(transaction)


def upload_to_drive(folder_id, filename, file_content, mimetype="text/csv"):
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/drive"])
    drive_service = build("drive", "v3", credentials=credentials)

    file_metadata = {"name": filename, "parents": [folder_id]}
    media = MediaIoBaseUpload(
        io.BytesIO(file_content.encode("utf-8")), mimetype=mimetype
    )
    uploaded = drive_service.files().create(
        body=file_metadata,
        media_body=media,
        fields="id",
        supportsAllDrives=True  # required for Shared Drive uploads
    ).execute()
    return uploaded.get("id")


@https_fn.on_request(cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"]))
def hive_collect_basic_data_sample(req: https_fn.Request) -> https_fn.Response:
    data = req.get_json(silent=True)
    if not data:
        return https_fn.Response("Missing JSON body", status=400)

    group = data.get("group")
    x, y, z = data.get("x"), data.get("y"), data.get("z")

    if group not in GROUP_DRIVE_FOLDERS:
        return https_fn.Response(f"Unknown group: {group}", status=400)
    if x is None or y is None or z is None:
        return https_fn.Response("Missing coordinates", status=400)

    box_id = f"X{x}_Y{y}_Z{z}"
    version = get_next_version_suffix(group, box_id)
    suffix = "" if version == 1 else f"_V{version}"
    filename = f"{box_id}{suffix}.csv"

    csv_content = generate_placeholder_csv(x, y, z)
    file_id = upload_to_drive(GROUP_DRIVE_FOLDERS[group], filename, csv_content)

    return https_fn.Response(
        json.dumps({"status": "ok", "filename": filename, "driveFileId": file_id}),
        status=200,
        content_type="application/json",
    )


# ======================================================================
# HIVE base station — advanced sample analysis, one Cloud Function per
# instrument. All six are placeholders for now: they just echo the inputs
# they received into the uploaded file (and the JSON response) so the wiring
# can be verified before the real per-instrument science model is written.
# They share this helper; each stays its own deployable function since the
# real implementations will eventually differ per instrument.
# ======================================================================

def _analysis_sample_number(drone_id):
    """Firestore atomic counter, one per drone, shared across all instruments —
    so HIVE-07's analyses are always HIVE-07_Analysis1, _Analysis2, ..."""
    db = firestore.client()
    doc_ref = (
        db.collection("groups").document("HIVE")
        .collection("analysisSamples").document(drone_id)
    )

    @firestore.transactional
    def update_in_transaction(transaction):
        snapshot = doc_ref.get(transaction=transaction)
        current = snapshot.get("sampleCount") if snapshot.exists else 0
        new_count = current + 1
        transaction.set(doc_ref, {"sampleCount": new_count}, merge=True)
        return new_count

    transaction = db.transaction()
    return update_in_transaction(transaction)


def _generate_analysis_file(instrument, drone_id, volume_l, filtration, origin, reagent=None):
    """Placeholder data generator shared by all 6 instrument functions. Just
    echoes the received inputs — replace with the real per-instrument science
    model later."""
    lines = [
        f"Instrument: {instrument}",
        f"Drone: {drone_id}",
        f"Sample volume analyzed (L): {volume_l}",
        f"Filtration: {filtration}",
        f"Origin position (m): x={origin.get('x')}, y={origin.get('y')}, z={origin.get('z')}",
    ]
    if reagent is not None:
        lines.append(f"Reagent: {reagent}")
    lines.append(f"Analyzed (UTC): {datetime.now(timezone.utc).isoformat()}")
    return "\n".join(lines) + "\n"


def _handle_analysis_request(req, instrument, requires_reagent=False):
    data = req.get_json(silent=True)
    if not data:
        return https_fn.Response("Missing JSON body", status=400)

    group = data.get("group", "HIVE")
    if group != "HIVE":
        return https_fn.Response(f"Unknown group for base station analysis: {group}", status=400)

    drone_id = data.get("droneId")
    volume_l = data.get("volumeL")
    filtration = data.get("filtration")
    origin = data.get("originPosition") or {}
    reagent = data.get("reagent")

    if not drone_id:
        return https_fn.Response("Missing droneId", status=400)
    if volume_l is None:
        return https_fn.Response("Missing volumeL", status=400)
    if requires_reagent and not reagent:
        return https_fn.Response("Missing reagent for incubation", status=400)

    sample_number = _analysis_sample_number(drone_id)
    instrument_stem = instrument.replace("-", "").replace(" ", "")
    filename = f"{drone_id}_Analysis{sample_number}_{instrument_stem}.txt"

    content = _generate_analysis_file(instrument, drone_id, volume_l, filtration, origin, reagent)
    file_id = upload_to_drive(
        GROUP_DRIVE_FOLDERS["HIVE"], filename, content, mimetype="text/plain"
    )

    return https_fn.Response(
        json.dumps({
            "status": "ok",
            "filename": filename,
            "driveFileId": file_id,
            "sampleNumber": sample_number,
            "receivedInputs": {
                "instrument": instrument,
                "droneId": drone_id,
                "volumeL": volume_l,
                "filtration": filtration,
                "originPosition": origin,
                "reagent": reagent,
            },
        }),
        status=200,
        content_type="application/json",
    )


@https_fn.on_request(cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"]))
def hive_analyze_sample_celif(req: https_fn.Request) -> https_fn.Response:
    return _handle_analysis_request(req, "CE-LIF")


@https_fn.on_request(cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"]))
def hive_analyze_sample_cec4d(req: https_fn.Request) -> https_fn.Response:
    return _handle_analysis_request(req, "CE-C4D")


@https_fn.on_request(cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"]))
def hive_analyze_sample_gcms(req: https_fn.Request) -> https_fn.Response:
    return _handle_analysis_request(req, "GCMS")


@https_fn.on_request(cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"]))
def hive_analyze_sample_fc(req: https_fn.Request) -> https_fn.Response:
    return _handle_analysis_request(req, "FC")


@https_fn.on_request(cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"]))
def hive_analyze_sample_microscope(req: https_fn.Request) -> https_fn.Response:
    return _handle_analysis_request(req, "Microscope")


@https_fn.on_request(cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"]))
def hive_analyze_sample_incubation(req: https_fn.Request) -> https_fn.Response:
    return _handle_analysis_request(req, "Incubation", requires_reagent=True)


# ======================================================================
# WhiteWhale tether game — station sample collection.
# Deliberately SEPARATE from hive_collect_basic_data_sample above: different
# file format, different naming, WhiteWhale Drive folder only, its own
# Firestore counter.
# ======================================================================

def generate_placeholder_station_file(station_label, sample_number, depth_m):
    """Placeholder data generator for WhiteWhale tether stations.
    Replace later with the real science model. Isolated here so swapping the
    file body doesn't touch the request handler."""
    lines = [
        f"Station: {station_label}",
        f"Sample number: {sample_number}",
        f"Assigned depth (m): {depth_m}",
        f"Collected (UTC): {datetime.now(timezone.utc).isoformat()}",
    ]
    return "\n".join(lines) + "\n"


def get_next_station_sample_number(group, station_id):
    """Firestore atomic counter so repeated collections at one station get
    _Sample1, _Sample2, ... even under concurrent presses."""
    db = firestore.client()
    doc_ref = (
        db.collection("groups").document(group)
        .collection("stationSamples").document(station_id)
    )

    @firestore.transactional
    def update_in_transaction(transaction):
        snapshot = doc_ref.get(transaction=transaction)
        current = snapshot.get("sampleCount") if snapshot.exists else 0
        new_count = current + 1
        transaction.set(doc_ref, {"sampleCount": new_count}, merge=True)
        return new_count

    transaction = db.transaction()
    return update_in_transaction(transaction)


@https_fn.on_request(cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"]))
def whale_collect_basic_data_sample(req: https_fn.Request) -> https_fn.Response:
    data = req.get_json(silent=True)
    if not data:
        return https_fn.Response("Missing JSON body", status=400)

    group = data.get("group")
    station_id = data.get("stationId")
    station_label = data.get("stationLabel") or station_id
    depth_m = data.get("depthM")

    if group not in GROUP_DRIVE_FOLDERS:
        return https_fn.Response(f"Unknown group: {group}", status=400)
    if not station_id:
        return https_fn.Response("Missing stationId", status=400)

    sample_number = get_next_station_sample_number(group, station_id)

    # "Station 3" -> "Station3"; fall back to the raw id if no digits present.
    digits = "".join(ch for ch in str(station_label) if ch.isdigit())
    name_stem = f"Station{digits}" if digits else str(station_id)
    filename = f"{name_stem}_Sample{sample_number}.txt"

    content = generate_placeholder_station_file(station_label, sample_number, depth_m)
    file_id = upload_to_drive(
        GROUP_DRIVE_FOLDERS[group], filename, content, mimetype="text/plain"
    )

    return https_fn.Response(
        json.dumps({
            "status": "ok",
            "filename": filename,
            "driveFileId": file_id,
            "sampleNumber": sample_number,
        }),
        status=200,
        content_type="application/json",
    )


# ... (existing imports and code stay above this) ...

DRONE_COUNT = 50  # keep in sync with js/games/hive-drone-explorer/config.js
STATION_COUNT = 4  # keep in sync with js/games/whitewhale-tether/config.js

def delete_collection(collection_ref, batch_size=100):
    """Firestore has no single 'delete collection' call — must delete
    documents in batches until none remain."""
    docs = collection_ref.limit(batch_size).stream()
    deleted = 0
    for doc in docs:
        doc.reference.delete()
        deleted += 1
    if deleted >= batch_size:
        # more may remain — recurse
        delete_collection(collection_ref, batch_size)


def _initial_base_station_state():
    """Must match initialBaseStationState() in
    js/games/hive-drone-explorer/base-station-engine.js."""
    return {
        "selectedDroneId": None,
        "filtration": None,
        "volumeToAnalyzeL": None,
        "instrument": None,
        "reagent": None,
        "stationStatus": "standby",
        "currentRun": None,
        "statusLog": [],
        "lastUpdated": firestore.SERVER_TIMESTAMP,
    }


def _reset_hive(group_ref, group):
    """HIVE drone-explorer reset: wipe box-visit + analysis-sample counters,
    every drone, and the base station."""
    delete_collection(group_ref.collection("boxVisits"))
    delete_collection(group_ref.collection("analysisSamples"))

    drones_ref = group_ref.collection("drones")
    for i in range(1, DRONE_COUNT + 1):
        drone_id = f"{group}-{i:02d}"
        drones_ref.document(drone_id).set({
            "status": "awaiting_command",
            "position": {"x": 0, "y": 0, "z": 0},
            "commandQueue": [],
            "hazardWarning": None,
            "destructionPoint": None,
            "destruction": None,
            "sample": None,
            "lastUpdated": firestore.SERVER_TIMESTAMP
        })

    group_ref.collection("baseStation").document("state").set(_initial_base_station_state())

    return {"dronesReset": DRONE_COUNT}


def _initial_tether_stations():
    """Must match initialStations() in js/games/whitewhale-tether/tether-engine.js."""
    return [
        {
            "id": f"station-{i}",
            "label": f"Station {i}",
            "assignedDepthM": None,
            "status": "awaiting_depth_assignment",
            "travelStartedAt": None,
            "arrivalAt": None,
            "deployingEndsAt": None,
            "collectingEndsAt": None,
            "lastCollection": None,
        }
        for i in range(1, STATION_COUNT + 1)
    ]


def _reset_whitewhale(group_ref):
    """WhiteWhale tether reset: wipe sample counters and the tether state doc.
    Does NOT touch drones — WhiteWhale has none."""
    delete_collection(group_ref.collection("stationSamples"))

    group_ref.collection("tether").document("state").set({
        "tetherStatus": "not_deployed",
        "tetherDeployStartedAt": None,
        "tetherDeployedAt": None,
        "oceanDepthM": None,
        "depthsLocked": False,
        "depthsSetAt": None,
        "stations": _initial_tether_stations(),
        "lastUpdated": firestore.SERVER_TIMESTAMP,
    })
    return {"stationsReset": STATION_COUNT}


@https_fn.on_request(cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"]))
def reset_group(req: https_fn.Request) -> https_fn.Response:
    data = req.get_json(silent=True)
    if not data or "group" not in data:
        return https_fn.Response("Missing 'group' in request body", status=400)

    group = data["group"]
    if group not in GROUP_DRIVE_FOLDERS:
        return https_fn.Response(f"Unknown group: {group}", status=400)

    db = firestore.client()
    group_ref = db.collection("groups").document(group)

    # Each group's first game has its own reset needs. "Reset WhiteWhale"
    # touches only the tether game; "Reset HIVE" touches only the drone game.
    if group == "WhiteWhale":
        result = _reset_whitewhale(group_ref)
    else:
        result = _reset_hive(group_ref, group)

    return https_fn.Response(
        json.dumps({"status": "ok", "group": group, **result}),
        status=200,
        content_type="application/json"
    )
