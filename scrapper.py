
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