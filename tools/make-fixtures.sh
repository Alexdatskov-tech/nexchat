#!/bin/bash
# Regenerates the TIFF fixtures test-tiff.js decodes. They are build artifacts,
# not source, so they are not committed -- run this after a fresh checkout or
# whenever /tmp is cleared. Requires ImageMagick.
set -e
cd "${1:-/tmp/nxtest}"
convert -size 64x48 gradient:red-blue png:grad.png
convert grad.png -compress none sample_uncompressed.tif
convert grad.png -compress LZW  sample_lzw.tif
convert grad.png -compress Zip  sample_zip.tif
echo "fixtures written to $(pwd)"
