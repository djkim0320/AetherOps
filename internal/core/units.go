package core

import (
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

const (
	UnitRegistryVersionV1      = "unit_registry_v1"
	CurrentUnitRegistryVersion = UnitRegistryVersionV1
	unitProjectionScaleV1      = 18

	KnowledgeDatatypeLength      = "aetherops:length"
	KnowledgeDatatypeArea        = "aetherops:area"
	KnowledgeDatatypeMass        = "aetherops:mass"
	KnowledgeDatatypeTime        = "aetherops:time"
	KnowledgeDatatypeSpeed       = "aetherops:speed"
	KnowledgeDatatypePressure    = "aetherops:pressure"
	KnowledgeDatatypeAngle       = "aetherops:angle"
	KnowledgeDatatypeTemperature = "aetherops:temperature"
)

type knowledgeUnitDefinition struct {
	dimension string
	siUnit    string
	factor    string
	offset    string
}

// unitRegistryV1 is intentionally small and exact. factor and offset are
// finite decimal rationals applied as SI = source*factor + offset. Extending or
// changing any entry requires a new registry version so old patches continue
// to validate identically.
var unitRegistryV1 = map[string]knowledgeUnitDefinition{
	// "1" is the canonical coherent unit for dimensionless quantities. It is
	// still a real dimension, not a wildcard for dimensioned datatypes.
	"1":    {dimension: "dimensionless", siUnit: "1", factor: "1", offset: "0"},
	"m":    {dimension: "length", siUnit: "m", factor: "1", offset: "0"},
	"mm":   {dimension: "length", siUnit: "m", factor: "0.001", offset: "0"},
	"cm":   {dimension: "length", siUnit: "m", factor: "0.01", offset: "0"},
	"km":   {dimension: "length", siUnit: "m", factor: "1000", offset: "0"},
	"m2":   {dimension: "area", siUnit: "m2", factor: "1", offset: "0"},
	"m²":   {dimension: "area", siUnit: "m2", factor: "1", offset: "0"},
	"mm2":  {dimension: "area", siUnit: "m2", factor: "0.000001", offset: "0"},
	"mm²":  {dimension: "area", siUnit: "m2", factor: "0.000001", offset: "0"},
	"cm2":  {dimension: "area", siUnit: "m2", factor: "0.0001", offset: "0"},
	"cm²":  {dimension: "area", siUnit: "m2", factor: "0.0001", offset: "0"},
	"km2":  {dimension: "area", siUnit: "m2", factor: "1000000", offset: "0"},
	"km²":  {dimension: "area", siUnit: "m2", factor: "1000000", offset: "0"},
	"kg":   {dimension: "mass", siUnit: "kg", factor: "1", offset: "0"},
	"g":    {dimension: "mass", siUnit: "kg", factor: "0.001", offset: "0"},
	"s":    {dimension: "time", siUnit: "s", factor: "1", offset: "0"},
	"ms":   {dimension: "time", siUnit: "s", factor: "0.001", offset: "0"},
	"min":  {dimension: "time", siUnit: "s", factor: "60", offset: "0"},
	"h":    {dimension: "time", siUnit: "s", factor: "3600", offset: "0"},
	"m/s":  {dimension: "speed", siUnit: "m/s", factor: "1", offset: "0"},
	"km/h": {dimension: "speed", siUnit: "m/s", factor: "5/18", offset: "0"},
	"Pa":   {dimension: "pressure", siUnit: "Pa", factor: "1", offset: "0"},
	"kPa":  {dimension: "pressure", siUnit: "Pa", factor: "1000", offset: "0"},
	"MPa":  {dimension: "pressure", siUnit: "Pa", factor: "1000000", offset: "0"},
	"rad":  {dimension: "angle", siUnit: "rad", factor: "1", offset: "0"},
	"deg":  {dimension: "angle", siUnit: "rad", factor: "0.017453292519943295", offset: "0"},
	"K":    {dimension: "temperature", siUnit: "K", factor: "1", offset: "0"},
	"C":    {dimension: "temperature", siUnit: "K", factor: "1", offset: "273.15"},
	"°C":   {dimension: "temperature", siUnit: "K", factor: "1", offset: "273.15"},
}

var dimensionedKnowledgeDatatypes = map[string]string{
	KnowledgeDatatypeLength:      "length",
	KnowledgeDatatypeArea:        "area",
	KnowledgeDatatypeMass:        "mass",
	KnowledgeDatatypeTime:        "time",
	KnowledgeDatatypeSpeed:       "speed",
	KnowledgeDatatypePressure:    "pressure",
	KnowledgeDatatypeAngle:       "angle",
	KnowledgeDatatypeTemperature: "temperature",
}

func validateKnowledgeUnitProjection(literal KnowledgeTypedLiteral, version string) error {
	if version != UnitRegistryVersionV1 {
		return fmt.Errorf("unsupported knowledge unit registry %q", version)
	}
	if isNonFiniteLiteral(literal.LexicalForm) || isNonFiniteLiteral(literal.SIValue) {
		return errors.New("knowledge literal cannot be NaN or infinite")
	}
	expectedDimension, dimensioned := dimensionedKnowledgeDatatypes[literal.Datatype]
	if literal.Unit == "" {
		if dimensioned {
			return fmt.Errorf("dimensioned datatype %q requires a unit", literal.Datatype)
		}
		if literal.SIValue != "" || literal.SIUnit != "" {
			return errors.New("unitless knowledge literal cannot contain an SI projection")
		}
		if isNumericKnowledgeDatatype(literal.Datatype) {
			if _, err := parseDecimalRational(literal.LexicalForm); err != nil {
				return fmt.Errorf("numeric knowledge literal: %w", err)
			}
		}
		return nil
	}

	definition, supported := unitRegistryV1[literal.Unit]
	if !supported {
		return fmt.Errorf("unsupported knowledge unit %q in registry %s", literal.Unit, version)
	}
	if !dimensioned && !isNumericKnowledgeDatatype(literal.Datatype) {
		return fmt.Errorf("unit-bearing datatype %q is not numeric or dimensioned", literal.Datatype)
	}
	if dimensioned && definition.dimension != expectedDimension {
		return fmt.Errorf("unit %q has dimension %s, want %s for datatype %q", literal.Unit, definition.dimension, expectedDimension, literal.Datatype)
	}
	if literal.SIValue == "" || literal.SIUnit == "" {
		return errors.New("unit-bearing knowledge literal requires an SI value and unit")
	}
	if literal.SIUnit != definition.siUnit {
		return fmt.Errorf("knowledge literal SI unit is %q, want %q", literal.SIUnit, definition.siUnit)
	}
	source, err := parseDecimalRational(literal.LexicalForm)
	if err != nil {
		return fmt.Errorf("knowledge literal source value: %w", err)
	}
	actual, err := parseDecimalRational(literal.SIValue)
	if err != nil {
		return fmt.Errorf("knowledge literal SI value: %w", err)
	}
	factor := registryRational(definition.factor)
	offset := registryRational(definition.offset)
	expected := new(big.Rat).Add(new(big.Rat).Mul(source, factor), offset)
	if expected.Cmp(actual) != 0 && strings.TrimSpace(literal.SIValue) != canonicalUnitProjectionV1(expected) {
		return fmt.Errorf("knowledge literal SI projection %q does not equal deterministic %s conversion", literal.SIValue, version)
	}
	return nil
}

// CanonicalizeUnitProjections derives every unit-bearing SI projection from
// the evidence-facing lexical value. Models retain responsibility for the
// cited source value and unit; the core owns conversion and serialization.
func (patch *KnowledgePatch) CanonicalizeUnitProjections() error {
	if patch == nil {
		return errors.New("knowledge patch is nil")
	}
	if patch.UnitRegistryVersion != UnitRegistryVersionV1 {
		return fmt.Errorf("unsupported knowledge unit registry %q", patch.UnitRegistryVersion)
	}
	canonicalize := func(literal *KnowledgeTypedLiteral) error {
		if literal == nil || literal.Unit == "" {
			return nil
		}
		definition, supported := unitRegistryV1[literal.Unit]
		if !supported {
			return fmt.Errorf("unsupported knowledge unit %q in registry %s", literal.Unit, patch.UnitRegistryVersion)
		}
		if literal.SIUnit != "" && literal.SIUnit != definition.siUnit {
			return fmt.Errorf("knowledge literal SI unit is %q, want %q", literal.SIUnit, definition.siUnit)
		}
		source, err := parseDecimalRational(literal.LexicalForm)
		if err != nil {
			return fmt.Errorf("knowledge literal source value: %w", err)
		}
		expected := new(big.Rat).Add(
			new(big.Rat).Mul(source, registryRational(definition.factor)),
			registryRational(definition.offset),
		)
		literal.SIValue = canonicalUnitProjectionV1(expected)
		literal.SIUnit = definition.siUnit
		return nil
	}
	for assertionIndex := range patch.Assertions {
		assertion := &patch.Assertions[assertionIndex]
		if err := canonicalize(assertion.ObjectLiteral); err != nil {
			return fmt.Errorf("knowledge assertion %q object: %w", assertion.ID, err)
		}
		for qualifierIndex := range assertion.Qualifiers {
			qualifier := &assertion.Qualifiers[qualifierIndex]
			if err := canonicalize(qualifier.Literal); err != nil {
				return fmt.Errorf("knowledge assertion %q qualifier %q: %w", assertion.ID, qualifier.Predicate, err)
			}
		}
	}
	return nil
}

func canonicalUnitProjectionV1(value *big.Rat) string {
	encoded := value.FloatString(unitProjectionScaleV1)
	encoded = strings.TrimRight(strings.TrimRight(encoded, "0"), ".")
	if encoded == "" || encoded == "-0" {
		return "0"
	}
	return encoded
}

func registryRational(value string) *big.Rat {
	rational, ok := new(big.Rat).SetString(value)
	if !ok {
		panic("invalid fixed knowledge unit registry value " + value)
	}
	return rational
}

func isNumericKnowledgeDatatype(datatype string) bool {
	name := strings.ToLower(strings.TrimSpace(datatype))
	if separator := strings.LastIndexAny(name, "#:"); separator >= 0 {
		name = name[separator+1:]
	}
	switch name {
	case "decimal", "double", "float", "integer", "int", "long", "short", "byte",
		"nonnegativeinteger", "nonpositiveinteger", "positiveinteger", "negativeinteger",
		"unsignedlong", "unsignedint", "unsignedshort", "unsignedbyte":
		return true
	default:
		return false
	}
}

var decimalRationalPattern = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

func parseDecimalRational(raw string) (*big.Rat, error) {
	value := strings.TrimSpace(raw)
	if value == "" || isNonFiniteLiteral(value) || !decimalRationalPattern.MatchString(value) {
		return nil, fmt.Errorf("%q is not a finite decimal", raw)
	}
	exponent := 0
	if position := strings.IndexAny(value, "eE"); position >= 0 {
		parsed, err := strconv.Atoi(value[position+1:])
		if err != nil || parsed < -1000 || parsed > 1000 {
			return nil, errors.New("decimal exponent is outside the supported range")
		}
		exponent = parsed
		value = value[:position]
	}
	sign := 1
	if value[0] == '+' || value[0] == '-' {
		if value[0] == '-' {
			sign = -1
		}
		value = value[1:]
	}
	fractionDigits := 0
	if position := strings.IndexByte(value, '.'); position >= 0 {
		fractionDigits = len(value) - position - 1
		value = value[:position] + value[position+1:]
	}
	numerator := new(big.Int)
	if _, ok := numerator.SetString(value, 10); !ok {
		return nil, fmt.Errorf("%q is not a finite decimal", raw)
	}
	if sign < 0 {
		numerator.Neg(numerator)
	}
	denominator := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(fractionDigits)), nil)
	if exponent > 0 {
		numerator.Mul(numerator, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(exponent)), nil))
	} else if exponent < 0 {
		denominator.Mul(denominator, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(-exponent)), nil))
	}
	return new(big.Rat).SetFrac(numerator, denominator), nil
}
