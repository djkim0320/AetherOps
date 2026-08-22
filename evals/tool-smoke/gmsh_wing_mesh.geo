SetFactory("OpenCASCADE");

span = 5.0;
rootChord = 2.0;
tipChord = 1.0;
sweepDeg = 15.0;
tipOffset = span * Tan(sweepDeg * Pi / 180.0);
meshSize = 0.25;

Point(1) = {0.0, 0.0, 0.0, meshSize};
Point(2) = {rootChord, 0.0, 0.0, meshSize};
Point(3) = {tipOffset + tipChord, span, 0.0, meshSize};
Point(4) = {tipOffset, span, 0.0, meshSize};

Line(1) = {1, 2};
Line(2) = {2, 3};
Line(3) = {3, 4};
Line(4) = {4, 1};
Curve Loop(1) = {1, 2, 3, 4};
Plane Surface(1) = {1};

Physical Surface("wing_planform") = {1};
Physical Curve("root") = {1};
Physical Curve("trailing") = {2};
Physical Curve("tip") = {3};
Physical Curve("leading") = {4};

Mesh.Algorithm = 6;
Mesh.MshFileVersion = 4.1;
