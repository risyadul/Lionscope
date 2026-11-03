# Changing the device's location

**Location** (the pin in the Device column's toolbar) puts the device somewhere else, like the Android Studio
emulator's Location controls: click the map (or drag its pin), type `-6.1754, 106.8272`, or paste a Google Maps or
OpenStreetMap link with coordinates in it, then **Set location**. Points you use often can be saved (in this
browser). The pin turns violet while Lionscope has moved the device, and **Reset** undoes it.

- **Emulators** get the point as their GPS fix (over the emulator's gRPC endpoint, or `adb emu geo fix` without
  one): apps see an ordinary location. Reset puts back the fix the emulator had before.
- **Physical devices (Android 12 and later)** get it from Android's test location providers: Lionscope lets the
  adb shell mock locations (`appops set com.android.shell android:mock_location allow`) and replaces the `gps`,
  `network` and `fused` providers with test ones that it sends the point to every second (`cmd location
providers …`). Google Play services' fused location follows them too. Apps see `Location.isMock()` as true, so
  an app that refuses mock locations won't take it. Nothing is installed on the phone.
- The phone gets its real location back on **Reset**, when the server stops, and, if the server was killed or the
  phone unplugged (or briefly offline) first, the next time a Lionscope server sees the phone: a marker file in
  `/data/local/tmp` says which server set it and what to restore. A phone another running Lionscope server moves is
  left alone (Set is refused), but **Reset** restores any phone Lionscope moved. Reset removes every `gps`,
  `network` and `fused` test provider, also one a mock-location app installed.
- If the device's location switch is off, the panel says so: apps then see no location at all.

The map's tiles come from [OpenStreetMap](https://www.openstreetmap.org/copyright) (`tile.openstreetmap.org`),
loaded only while the panel is open; it is the only thing the dashboard loads from the internet. Coordinates typed
or pasted never leave your machine except as the map tiles you look at.
