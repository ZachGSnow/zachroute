// Color tables the radar tiles are drawn with, so each pixel can be read back to a value.
// Copied from each source's own table (see the comments). Space-separated hex colors.

/**
 * IEM NEXRAD base reflectivity (N0Q), palette indexes 105 to 255; index i is i / 2 - 32.5 dBZ
 * (IEM: "NODATA, -32 dBZ through 90 dBZ, 0.5 dBZ increment"). From the palette of
 * mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.png, which the tiles share.
 * Indexes under 105 (under 20 dBZ) are left out: the layer does not draw them.
 */
export const IEM_N0Q_FROM_INDEX = 105;
export const IEM_N0Q = `
  43d67e 3cd66d 35d65b 11d518 11d117 10cd17 10c816 10c416 0fbc15 0fb714
  0eb314 0eaf13 0eab13 0da612 0da212 0d9e11 0c9911 0c9510 0c9110 0b880f
  0b840e 0a800e 0a7c0d 0a770d 09730c 096f0c 096b0b 08660b 08620a 095e09
  327308 467d08 5b8807 6f9207 849d06 98a806 adb205 c1bd05 d6c704 ead204
  ffe200 ffd800 ffd300 ffce00 ffc900 ffc400 ffc000 ffbb00 ffb600 ffb100
  ffac00 ffa700 ffa200 ff9900 ff9400 ff8f00 ff8a00 ff8500 ff8000 ff0000
  f80000 f10000 ea0000 e30000 d50000 cd0000 c60000 bf0000 b80000 b10000
  aa0000 a30000 9b0000 940000 8d0000 7f0000 780000 710000 ffffff fff5ff
  ffeaff ffdfff ffd4ff ffc9ff ffbeff ffb3ff ff9dff ff92ff ff75ff fc6bfd
  f960fa f656f7 f34bf4 f040f1 ed36ef ea2bec e720e9 e10be3 b200ff ac00fc
  a400f7 9b00f4 9300ef 8800ea 8300e8 7900e2 7200dd 6900db 05ecf0 05ebf0
  05eaf0 05dde0 05dce0 05dbe0 05cdd0 05ccd0 04bdc0 04bcc0 04bbc0 04aeb0
  04adb0 049ea0 049da0 049ca0 038e90 038d90 038c90 037e80 037d80 036f70
  036e70 036d70 025f60 025e60 024f50 024e50 024d50 023f40 023e40 023d40
  013030 012f30 012020 011f20 011e20 3a67b5 3a66b5 3a65b5 3a64b5 3a63b5
  3a62b5
`;

/**
 * IEM NEXRAD echo tops (EET), palette indexes 2 to 71; index i is i thousand feet. From the color
 * map of mesonet.agron.iastate.edu/data/gis/images/900913/USCOMP/eet_0.tif.
 */
export const IEM_EET_FROM_KFT = 2;
export const IEM_EET = `
  5f73a7 576da4 4f67a2 4761a0 415b9e 4568a6 4a76ae 4f84b6 5492bf 599fc7
  5eadcf 62bbd8 67c9e0 6fd6e8 61d6c5 52d6a2 43d67e 35d65b 11d117 10c816
  0fc015 0fb714 0eaf13 0da612 0d9e11 0c9510 0b8d0f 0b840e 0a7c0d 09730c
  096b0b 08620a 1d6809 467d08 6f9207 98a806 c1bd05 ead204 ffdd00 ffd300
  ffc900 ffc000 ffb600 ffac00 ffa200 ff9900 ff8f00 ff8500 ff0000 f10000
  e30000 d50000 c60000 b80000 aa0000 9b0000 8d0000 7f0000 710000 fff5ff
  ffdfff ffc9ff ffb3ff ff9dff ff75ff f960fa f34bf4 ed36ef e720e9 e10be3
`;

/**
 * RainViewer "Universal Blue" (color scheme 2, rain), 20 to 95 dBZ, one entry per dBZ. From
 * rainviewer.com/files/rainviewer_api_colors_table.csv. Some values share a color (white from 65,
 * green from 75); all of them are past the top of the scale here.
 */
export const RAINVIEWER_FROM_DBZ = 20;
export const RAINVIEWER = `
  00a3e0 009ad5 0091ca 0088bf 007fb4 0077aa 0070a3 00699c 006295 005b8e
  005588 005180 004e78 004a70 004768 ffee00 ffe000 ffd200 ffc500 ffb700
  ffaa00 ff9f00 ff9500 ff8b00 ff8100 ff4400 f23600 e62800 d91b00 cd0d00
  c10000 a80000 8f0000 760000 5d0000 ffaaff ff9fff ff95ff ff8bff ff81ff
  ff77ff ff6cff ff62ff ff58ff ff4eff ffffff ffffff ffffff ffffff ffffff
  ffffff ffffff ffffff ffffff ffffff 00ff00 00ff00 00ff00 00ff00 00ff00
  00ff00 00ff00 00ff00 00ff00 00ff00 00ff00 00ff00 00ff00 00ff00 00ff00
  00ff00 00ff00 00ff00 00ff00 00ff00 00ff00
`;
