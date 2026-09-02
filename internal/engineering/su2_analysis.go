//go:build windows && amd64

package engineering

import (
	"bufio"
	"encoding/csv"
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

var su2QualityRow = regexp.MustCompile(`^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|`)

type su2SurfacePoint struct {
	x  float64
	y  float64
	cp float64
}

func mergeSU2Metrics(target map[string]any, values map[string]any) error {
	for key, value := range values {
		if _, duplicate := target[key]; duplicate {
			return fmt.Errorf("duplicate SU2 metric %q", key)
		}
		target[key] = value
	}
	return nil
}

func parseSU2MeshMetrics(path string) (map[string]any, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read SU2 mesh: %w", err)
	}
	defer file.Close()
	metrics := map[string]any{}
	marker := ""
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		switch key {
		case "NELEM":
			parsed, err := strconv.Atoi(strings.Fields(value)[0])
			if err != nil || parsed <= 0 {
				return nil, errors.New("SU2 mesh has an invalid NELEM value")
			}
			metrics["mesh_volume_elements"] = parsed
		case "NPOIN":
			parsed, err := strconv.Atoi(strings.Fields(value)[0])
			if err != nil || parsed <= 0 {
				return nil, errors.New("SU2 mesh has an invalid NPOIN value")
			}
			metrics["mesh_nodes"] = parsed
		case "MARKER_TAG":
			marker = strings.ToLower(value)
		case "MARKER_ELEMS":
			parsed, err := strconv.Atoi(strings.Fields(value)[0])
			if err != nil || parsed <= 0 {
				return nil, errors.New("SU2 mesh has an invalid MARKER_ELEMS value")
			}
			switch marker {
			case "airfoil":
				metrics["airfoil_boundary_elements"] = parsed
			case "farfield":
				metrics["farfield_boundary_elements"] = parsed
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan SU2 mesh: %w", err)
	}
	for _, key := range []string{"mesh_nodes", "mesh_volume_elements", "airfoil_boundary_elements", "farfield_boundary_elements"} {
		if _, ok := metrics[key]; !ok {
			return nil, fmt.Errorf("SU2 mesh omits %s", key)
		}
	}
	return metrics, nil
}

func parseSU2LogMetrics(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read SU2 log: %w", err)
	}
	text := string(data)
	if !strings.Contains(text, "All volume elements are correctly oriented.") {
		return nil, errors.New("SU2 log does not prove volume-element orientation")
	}
	metrics := map[string]any{
		"mesh_orientation_valid":  true,
		"orthogonality_available": false,
	}
	wanted := map[string][2]string{
		"Orthogonality Angle (deg.)": {"orthogonality_min_deg", "orthogonality_max_deg"},
		"CV Face Area Aspect Ratio":  {"cv_face_area_aspect_min", "cv_face_area_aspect_max"},
		"CV Sub-Volume Ratio":        {"cv_subvolume_ratio_min", "cv_subvolume_ratio_max"},
	}
	for _, line := range strings.Split(text, "\n") {
		match := su2QualityRow.FindStringSubmatch(strings.TrimSpace(line))
		if len(match) != 4 {
			continue
		}
		keys, ok := wanted[strings.TrimSpace(match[1])]
		if !ok {
			continue
		}
		minimum, minErr := strconv.ParseFloat(strings.TrimSpace(match[2]), 64)
		maximum, maxErr := strconv.ParseFloat(strings.TrimSpace(match[3]), 64)
		if minErr != nil || maxErr != nil || !finite(minimum, maximum) || maximum < minimum {
			// SU2 8.5 can report nan for the dual-control-volume
			// orthogonality statistic even when it separately proves that all
			// volume elements are oriented and emits the other quality metrics.
			// Preserve that limitation explicitly instead of rejecting a
			// completed solve or inventing a replacement value.
			if keys[0] == "orthogonality_min_deg" &&
				strings.EqualFold(strings.TrimSpace(match[2]), "nan") &&
				strings.EqualFold(strings.TrimSpace(match[3]), "nan") {
				continue
			}
			return nil, fmt.Errorf("SU2 log has invalid %s bounds", match[1])
		}
		metrics[keys[0]], metrics[keys[1]] = minimum, maximum
		if keys[0] == "orthogonality_min_deg" {
			metrics["orthogonality_available"] = true
		}
	}
	for label, keys := range wanted {
		if label == "Orthogonality Angle (deg.)" {
			continue
		}
		if _, ok := metrics[keys[0]]; !ok {
			return nil, fmt.Errorf("SU2 log omits quality metric %s", keys[0])
		}
	}
	return metrics, nil
}

func parseSU2SurfaceMetrics(path string, mach float64) (map[string]any, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read SU2 surface: %w", err)
	}
	defer file.Close()
	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true
	records, err := reader.ReadAll()
	if err != nil || len(records) < 5 {
		return nil, errors.New("SU2 surface CSV contains too few valid rows")
	}
	headers := make(map[string]int)
	for index, value := range records[0] {
		headers[normalizeHeader(value)] = index
	}
	lookup := func(names ...string) (int, error) {
		for _, name := range names {
			if index, ok := headers[name]; ok {
				return index, nil
			}
		}
		return -1, fmt.Errorf("SU2 surface omits columns %v", names)
	}
	xIndex, err := lookup("X")
	if err != nil {
		return nil, err
	}
	yIndex, err := lookup("Y")
	if err != nil {
		return nil, err
	}
	rhoIndex, err := lookup("DENSITY")
	if err != nil {
		return nil, err
	}
	mxIndex, err := lookup("MOMENTUM_X")
	if err != nil {
		return nil, err
	}
	myIndex, err := lookup("MOMENTUM_Y")
	if err != nil {
		return nil, err
	}
	energyIndex, err := lookup("ENERGY")
	if err != nil {
		return nil, err
	}
	parse := func(record []string, index int) (float64, error) {
		if index < 0 || index >= len(record) {
			return 0, errors.New("SU2 surface row is truncated")
		}
		return strconv.ParseFloat(strings.TrimSpace(record[index]), 64)
	}
	const gamma = 1.4
	const pressureInf = 101325.0
	dynamicPressure := .5 * gamma * pressureInf * mach * mach
	if !finite(dynamicPressure) || dynamicPressure <= 0 {
		return nil, errors.New("SU2 surface dynamic pressure is invalid")
	}
	points := make([]su2SurfacePoint, 0, len(records)-1)
	for rowIndex, record := range records[1:] {
		x, xErr := parse(record, xIndex)
		y, yErr := parse(record, yIndex)
		rho, rhoErr := parse(record, rhoIndex)
		mx, mxErr := parse(record, mxIndex)
		my, myErr := parse(record, myIndex)
		energy, energyErr := parse(record, energyIndex)
		if xErr != nil || yErr != nil || rhoErr != nil || mxErr != nil || myErr != nil || energyErr != nil ||
			!finite(x, y, rho, mx, my, energy) || rho <= 0 {
			return nil, fmt.Errorf("SU2 surface row %d is invalid", rowIndex+2)
		}
		pressure := (gamma - 1) * (energy - .5*(mx*mx+my*my)/rho)
		cp := (pressure - pressureInf) / dynamicPressure
		if !finite(pressure, cp) || pressure <= 0 {
			return nil, fmt.Errorf("SU2 surface row %d produces invalid pressure", rowIndex+2)
		}
		points = append(points, su2SurfacePoint{x: x, y: y, cp: cp})
	}
	var spacing []float64
	for index := 1; index < len(points); index++ {
		distance := math.Hypot(points[index].x-points[index-1].x, points[index].y-points[index-1].y)
		if distance > 0 && finite(distance) {
			spacing = append(spacing, distance)
		}
	}
	if len(spacing) == 0 {
		return nil, errors.New("SU2 surface spacing cannot be reconstructed")
	}
	upper := make([]su2SurfacePoint, 0, len(points)/2)
	lower := make([]su2SurfacePoint, 0, len(points)/2)
	for _, point := range points {
		if point.y >= 0 {
			upper = append(upper, point)
		}
		if point.y <= 0 {
			lower = append(lower, point)
		}
	}
	upperX, upperDelta, err := su2ShockLocation(upper)
	if err != nil {
		return nil, fmt.Errorf("upper-surface shock: %w", err)
	}
	lowerX, lowerDelta, err := su2ShockLocation(lower)
	if err != nil {
		return nil, fmt.Errorf("lower-surface shock: %w", err)
	}
	spacingMean, _, spacingMin, spacingMax := finiteStats(spacing)
	return map[string]any{
		"surface_points": len(points), "surface_spacing_mean_m": spacingMean,
		"surface_spacing_min_m": spacingMin, "surface_spacing_max_m": spacingMax,
		"upper_shock_x_over_c": upperX, "upper_shock_delta_cp": upperDelta,
		"lower_shock_x_over_c": lowerX, "lower_shock_delta_cp": lowerDelta,
	}, nil
}

func su2ShockLocation(points []su2SurfacePoint) (float64, float64, error) {
	if len(points) < 4 {
		return 0, 0, errors.New("too few surface points")
	}
	slices.SortFunc(points, func(left, right su2SurfacePoint) int {
		if left.x < right.x {
			return -1
		}
		if left.x > right.x {
			return 1
		}
		return 0
	})
	bestGradient, bestX, bestDelta := -1.0, 0.0, 0.0
	for index := 1; index < len(points); index++ {
		left, right := points[index-1], points[index]
		dx := right.x - left.x
		midpoint := .5 * (left.x + right.x)
		// Exclude the leading- and trailing-edge curvature zones. Their geometric
		// pressure gradients are not evidence of a captured transonic shock.
		if dx <= 1e-9 || midpoint < .15 || midpoint > .9 {
			continue
		}
		delta := math.Abs(right.cp - left.cp)
		gradient := delta / dx
		if gradient > bestGradient {
			bestGradient, bestX, bestDelta = gradient, midpoint, delta
		}
	}
	if bestGradient < 0 || !finite(bestX, bestDelta) {
		return 0, 0, errors.New("no interior pressure jump")
	}
	return bestX, bestDelta, nil
}

func finiteStats(values []float64) (mean, stddev, minimum, maximum float64) {
	minimum, maximum = values[0], values[0]
	for _, value := range values {
		mean += value
		minimum = math.Min(minimum, value)
		maximum = math.Max(maximum, value)
	}
	mean /= float64(len(values))
	for _, value := range values {
		delta := value - mean
		stddev += delta * delta
	}
	stddev = math.Sqrt(stddev / float64(len(values)))
	return mean, stddev, minimum, maximum
}
