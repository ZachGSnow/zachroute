// Meteosat infrared calibration: EUMETSAT's free hourly images are 8-bit gray with no published
// temperature scale, so gray was matched to cloud-top temperature against NASA GIBS images of the
// same hour where two satellites see the same clouds (quantile matching over the shared area, which
// tolerates the small misalignments between satellites). Captured 19 Oct 2026, 22-23 UTC:
//   - Meteosat-12 against GOES-East near their midpoint (45 to 22.5 W).
//   - Meteosat-9 against Meteosat-12 near theirs (11 to 34 E), and separately against Himawari near
//     theirs (90 to 101 E). The two disagree by up to about 15 C in mid-levels, so each pixel blends
//     them by longitude: each seam then matches its neighbor.
// Both Meteosats' images saturate between about -60 and -70 C, so the coldest tops read no colder.
// Tables are [temperature C, gray], warm to cold, gray rising.

export const METEOSAT_12_GRAY: Array<[number, number]> = [[25, 15], [20, 23], [15, 33], [10, 45], [5, 59], [0, 71], [-5, 85], [-10, 103], [-15, 132], [-20, 146], [-25, 152], [-30, 160], [-35, 162], [-40, 168], [-45, 174], [-50, 188], [-55, 202], [-60, 214], [-65, 236], [-70, 255]];
export const METEOSAT_9_GRAY_WEST: Array<[number, number]> = [[25, 0], [20, 21], [15, 31], [10, 47], [5, 71], [0, 88], [-5, 104], [-10, 126], [-15, 162], [-20, 183], [-25, 191], [-30, 196], [-35, 199], [-40, 204], [-45, 209], [-50, 221], [-55, 233], [-60, 242], [-65, 253], [-70, 255]];
export const METEOSAT_9_GRAY_EAST: Array<[number, number]> = [[25, 19], [20, 20], [15, 32], [10, 53], [5, 83], [0, 104], [-5, 126], [-10, 150], [-15, 192], [-20, 218], [-25, 225], [-30, 231], [-35, 235], [-40, 239], [-45, 243], [-50, 247], [-55, 251], [-60, 255]];

/**
 * NASA GIBS clean infrared colormap ("Clean_Longwave_Infrared_Window_Band", v1.3), the part below
 * 0 C: each entry is the lower bound of a temperature range (C) and its color. Meteosat pixels are
 * drawn in these colors so they look like the GIBS satellites next to them.
 */
export const GIBS_IR_COLORS = `
  -92.1:ffffff -91.1:7f007f -90.1:8c0d87 -89.1:99198e -88.1:a52696 -87.1:b2339d -86.1:bf40a5
  -85.1:cc4cad -84.1:d959b4 -83.1:e566bc -82.1:f272c3 -81.1:ff7fcb -80.1:e6e6e6 -79.1:cccccc
  -78.1:b1b1b1 -77.1:9b9b9b -76.1:818181 -75.1:666666 -74.1:4c4c4c -73.1:363636 -72.1:1b1b1b
  -71.1:050505 -70.1:1a0000 -69.1:330000 -68.1:4d0000 -67.1:660000 -66.1:800000 -65.1:990000
  -64.1:b30000 -63.1:cc0000 -62.1:e60000 -61.1:ff0000 -60.1:ff1a00 -59.1:ff3300 -58.1:ff4d00
  -57.1:ff6600 -56.1:ff8000 -55.1:ff9900 -54.1:ffb300 -53.1:ffcc00 -52.1:ffe600 -51.1:ffff00
  -50.1:e6ff00 -49.1:ccff00 -48.1:b3ff00 -47.1:99ff00 -46.1:80ff00 -45.1:66ff00 -44.1:4dff00
  -43.1:33ff00 -42.1:1aff00 -41.1:00ff00 -40.1:00ea0a -39.1:00d413 -38.1:00bf1d -37.1:00aa26
  -36.1:009530 -35.1:00803a -34.1:006a43 -33.1:00554d -32.1:004056 -31.1:002a60 -30.6:001569
  -30.1:000073 -29.6:00007d -29.1:000d7a -28.6:001a81 -28.1:002688 -27.6:00338f -27.1:004096
  -26.6:004c9d -26.1:0059a4 -25.6:0066ab -25.1:0073b2 -24.6:0080b9 -24.1:008cc0 -23.6:0099c7
  -23.1:00a6ce -22.6:00b2d5 -22.1:00bfdc -21.6:00cce3 -21.1:00d9ea -20.6:00e6f1 -20.1:00f2f8
  -19.6:00ffff -19.1:c5c5c5 -18.6:c4c4c4 -18.1:c2c2c2 -17.6:c1c1c1 -17.1:c0c0c0 -16.6:bfbfbf
  -16.1:bdbdbd -15.6:bcbcbc -15.1:bbbbbb -14.6:b9b9b9 -14.1:b8b8b8 -13.6:b7b7b7 -13.1:b5b5b5
  -12.6:b4b4b4 -12.1:b3b3b3 -11.6:b2b2b2 -11.1:b0b0b0 -10.6:afafaf -10.1:aeaeae -9.6:acacac
  -9.1:ababab -8.6:aaaaaa -8.1:a9a9a9 -7.6:a7a7a7 -7.1:a6a6a6 -6.6:a5a5a5 -6.1:a3a3a3 -5.6:a2a2a2
  -5.1:a1a1a1 -4.6:9f9f9f -4.1:9e9e9e -3.6:9d9d9d -3.1:9c9c9c -2.6:9a9a9a -2.1:999999 -1.6:989898
  -1.1:969696 -0.6:959595 -0.1:949494
`;
