package core

import "sort"

const (
	// EngineeringScreeningOwnerOrdinal is the only normal COLLECT ordinal that
	// may launch XFOIL optimization screening jobs. Public-source collection
	// remains parallel across every planned workstream, while the numerical
	// sweep has one durable owner and therefore one attempt-scoped receipt set.
	EngineeringScreeningOwnerOrdinal = 0
)

type EngineeringMetricKind string

const (
	EngineeringMetricInteger EngineeringMetricKind = "integer"
	EngineeringMetricDecimal EngineeringMetricKind = "decimal"
	EngineeringMetricAngle   EngineeringMetricKind = "angle"
	EngineeringMetricLength  EngineeringMetricKind = "length"
	EngineeringMetricBoolean EngineeringMetricKind = "boolean"
	EngineeringMetricString  EngineeringMetricKind = "string"
)

type EngineeringMetricContract struct {
	Kind     EngineeringMetricKind
	Unit     string
	Optional bool
}

var su2MetricContractsV1 = map[string]EngineeringMetricContract{
	"iterations":                 {Kind: EngineeringMetricInteger},
	"cl":                         {Kind: EngineeringMetricDecimal},
	"cd":                         {Kind: EngineeringMetricDecimal},
	"initial_rms_density":        {Kind: EngineeringMetricDecimal},
	"final_rms_density":          {Kind: EngineeringMetricDecimal},
	"residual_drop_orders":       {Kind: EngineeringMetricDecimal},
	"late_window_iterations":     {Kind: EngineeringMetricInteger},
	"cl_late_mean":               {Kind: EngineeringMetricDecimal},
	"cl_late_stddev":             {Kind: EngineeringMetricDecimal},
	"cl_late_range":              {Kind: EngineeringMetricDecimal},
	"cd_late_mean":               {Kind: EngineeringMetricDecimal},
	"cd_late_stddev":             {Kind: EngineeringMetricDecimal},
	"cd_late_range":              {Kind: EngineeringMetricDecimal},
	"mesh_nodes":                 {Kind: EngineeringMetricInteger},
	"mesh_volume_elements":       {Kind: EngineeringMetricInteger},
	"airfoil_boundary_elements":  {Kind: EngineeringMetricInteger},
	"farfield_boundary_elements": {Kind: EngineeringMetricInteger},
	"mesh_orientation_valid":     {Kind: EngineeringMetricBoolean},
	"orthogonality_available":    {Kind: EngineeringMetricBoolean},
	"orthogonality_min_deg":      {Kind: EngineeringMetricAngle, Unit: "deg", Optional: true},
	"orthogonality_max_deg":      {Kind: EngineeringMetricAngle, Unit: "deg", Optional: true},
	"cv_face_area_aspect_min":    {Kind: EngineeringMetricDecimal},
	"cv_face_area_aspect_max":    {Kind: EngineeringMetricDecimal},
	"cv_subvolume_ratio_min":     {Kind: EngineeringMetricDecimal},
	"cv_subvolume_ratio_max":     {Kind: EngineeringMetricDecimal},
	"surface_points":             {Kind: EngineeringMetricInteger},
	"surface_spacing_mean_m":     {Kind: EngineeringMetricLength, Unit: "m"},
	"surface_spacing_min_m":      {Kind: EngineeringMetricLength, Unit: "m"},
	"surface_spacing_max_m":      {Kind: EngineeringMetricLength, Unit: "m"},
	"upper_shock_x_over_c":       {Kind: EngineeringMetricDecimal},
	"upper_shock_delta_cp":       {Kind: EngineeringMetricDecimal},
	"lower_shock_x_over_c":       {Kind: EngineeringMetricDecimal},
	"lower_shock_delta_cp":       {Kind: EngineeringMetricDecimal},
	"solver":                     {Kind: EngineeringMetricString},
	"conv_num_method_flow":       {Kind: EngineeringMetricString},
	"cfl_number":                 {Kind: EngineeringMetricDecimal},
	"conv_residual_minval":       {Kind: EngineeringMetricDecimal},
	"farfield_x_min_chords":      {Kind: EngineeringMetricDecimal},
	"farfield_x_max_chords":      {Kind: EngineeringMetricDecimal},
	"farfield_y_abs_chords":      {Kind: EngineeringMetricDecimal},
}

var su2GeneralMetricContractsV1 = map[string]EngineeringMetricContract{
	"case_id":                 {Kind: EngineeringMetricString},
	"solver":                  {Kind: EngineeringMetricString},
	"turbulence_model":        {Kind: EngineeringMetricString},
	"mesh_sha256":             {Kind: EngineeringMetricString},
	"source_config_sha256":    {Kind: EngineeringMetricString, Optional: true},
	"effective_config_sha256": {Kind: EngineeringMetricString},
	"mesh_dimension":          {Kind: EngineeringMetricInteger},
	"mesh_nodes":              {Kind: EngineeringMetricInteger},
	"mesh_elements":           {Kind: EngineeringMetricInteger},
	"mesh_markers":            {Kind: EngineeringMetricInteger},
	"history_rows":            {Kind: EngineeringMetricInteger},
	"history_columns":         {Kind: EngineeringMetricInteger},
	"final_iteration":         {Kind: EngineeringMetricInteger, Optional: true},
	"converged":               {Kind: EngineeringMetricBoolean},
	"termination_reason":      {Kind: EngineeringMetricString},
	"cl":                      {Kind: EngineeringMetricDecimal, Optional: true},
	"cd":                      {Kind: EngineeringMetricDecimal, Optional: true},
	"final_rms_density":       {Kind: EngineeringMetricDecimal, Optional: true},
}

// SU2MetricContractsV1 is the single scalar contract shared by the solver
// model view and deterministic knowledge projection. A copy prevents callers
// from mutating the process-wide authority.
func SU2MetricContractsV1() map[string]EngineeringMetricContract {
	result := make(map[string]EngineeringMetricContract, len(su2MetricContractsV1))
	for key, contract := range su2MetricContractsV1 {
		result[key] = contract
	}
	return result
}

func SU2MetricEvidencePathsV1() [][]string {
	keys := make([]string, 0, len(su2MetricContractsV1))
	for key := range su2MetricContractsV1 {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	paths := make([][]string, len(keys))
	for index, key := range keys {
		paths[index] = []string{key}
	}
	return paths
}

// SU2GeneralMetricContractsV1 is the graph/evidence contract for the general
// project-owned SU2_CFD path. Arbitrary final history columns remain in the
// receipt/CAS; only these stable cross-physics scalars become graph assertions.
func SU2GeneralMetricContractsV1() map[string]EngineeringMetricContract {
	result := make(map[string]EngineeringMetricContract, len(su2GeneralMetricContractsV1))
	for key, contract := range su2GeneralMetricContractsV1 {
		result[key] = contract
	}
	return result
}

func SU2GeneralMetricEvidencePathsV1() [][]string {
	keys := make([]string, 0, len(su2GeneralMetricContractsV1))
	for key := range su2GeneralMetricContractsV1 {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	paths := make([][]string, len(keys))
	for index, key := range keys {
		paths[index] = []string{key}
	}
	return paths
}
