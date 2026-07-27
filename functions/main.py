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


def upload_to_drive(folder_id, filename, csv_content):
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/drive"])
    drive_service = build("drive", "v3", credentials=credentials)

    file_metadata = {"name": filename, "parents": [folder_id]}
    media = MediaIoBaseUpload(
        io.BytesIO(csv_content.encode("utf-8")), mimetype="text/csv"
    )
    uploaded = drive_service.files().create(
        body=file_metadata,
        media_body=media,
        fields="id",
        supportsAllDrives=True  # required for Shared Drive uploads
    ).execute()
    return uploaded.get("id")


@https_fn.on_request(cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"]))
def collect_sample(req: https_fn.Request) -> https_fn.Response:
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
        {"status": "ok", "filename": filename, "driveFileId": file_id},
        status=200,
        content_type="application/json",
    )

# ... (existing imports and code stay above this) ...

DRONE_COUNT = 50  # keep in sync with js/games/hive-drone-explorer/config.js

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

    # Wipe visit counters so file-versioning (_V2, _V3...) starts fresh
    delete_collection(group_ref.collection("boxVisits"))

    # Reset every drone to its starting state
    drones_ref = group_ref.collection("drones")
    for i in range(1, DRONE_COUNT + 1):
        drone_id = f"{group}-{i:02d}"
        drones_ref.document(drone_id).set({
            "status": "awaiting_command",
            "position": {"x": 0, "y": 0, "z": 0},
            "commandQueue": [],
            "lastUpdated": firestore.SERVER_TIMESTAMP
        })

    return https_fn.Response(
        {"status": "ok", "group": group, "dronesReset": DRONE_COUNT},
        status=200,
        content_type="application/json"
    )