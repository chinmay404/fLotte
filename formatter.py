import requests
import re

# 1. Fetch the main page to get a fresh session and security token
session = requests.Session()
page_url = "https://flotte-berlin.de/lastenrad-ausleihen/standorte/bezirke/"
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

print("Fetching main page to get a fresh nonce...")
html_response = session.get(page_url, headers=headers).text

# 2. Extract the fresh nonce using a regular expression
nonce_match = re.search(r'cb_map\.settings = \{.*?"nonce":"([a-f0-9]+)"', html_response)

if not nonce_match:
    raise SystemExit("Could not find the security nonce in the HTML. The site may have updated.")

fresh_nonce = nonce_match.group(1)
print(f"Success! Found fresh nonce: {fresh_nonce}")

# 3. Ask the AJAX endpoint for the map data
ajax_url = "https://flotte-berlin.de/wp-admin/admin-ajax.php"

payload = {
    "action": "cb_map_locations",
    "nonce": fresh_nonce,
    "cb_map_id": "10460"
}

print("Downloading location data...\n")
response = session.post(ajax_url, data=payload, headers=headers)
map_data = response.json() # This is your raw list

# 4. Loop through the list and extract the data
print(f"Successfully fetched {len(map_data)} stations!\n")

for station in map_data:
    # Get the station details
    loc_name = station.get('location_name', 'Unknown')
    lat = station.get('lat')
    lon = station.get('lon')
    street = station.get('address', {}).get('street', 'Unknown Street')

    # Get a list of the bike names at this station
    bikes = [bike.get('name') for bike in station.get('items', [])]
    bike_names = ", ".join(bikes)

    # Print it out nicely
    print(f"🚲 {loc_name}")
    print(f"📍 {street} ({lat}, {lon})")
    print(f"📦 Bikes: {bike_names}")
    print("-" * 40)
