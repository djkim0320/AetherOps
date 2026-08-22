//go:build windows && amd64

// Package su2host performs the native, non-configurable CPU/OS-state
// preflight required by the packaged SU2 win64-omp runtime.
package su2host

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

const (
	ObservationSchemaV1        = "aetherops_su2_native_host_observation_v1"
	CandidatePreflightSchemaV1 = "aetherops_su2_candidate_preflight_v1"
	PreflightFunctionV1        = "su2host.RequireNative/v1"
)

// Observation preserves the native CPUID leaves and XCR0 value from which all
// feature booleans are deterministically derived. No environment or fixture
// input participates in ObserveNative.
type Observation struct {
	Schema             string `json:"schema"`
	VendorID           string `json:"vendor_id"`
	MaximumBasicLeaf   uint32 `json:"maximum_basic_leaf"`
	ProcessorSignature uint32 `json:"processor_signature"`
	Leaf1ECX           uint32 `json:"leaf_1_ecx"`
	Leaf7EBX           uint32 `json:"leaf_7_subleaf_0_ebx"`
	XCR0               uint64 `json:"xcr0"`
	AVX                bool   `json:"avx"`
	AVX2               bool   `json:"avx2"`
	FMA                bool   `json:"fma"`
	BMI1               bool   `json:"bmi1"`
	BMI2               bool   `json:"bmi2"`
	XSAVE              bool   `json:"xsave"`
	OSXSAVE            bool   `json:"osxsave"`
	HypervisorPresent  bool   `json:"hypervisor_present"`
	XMMStateEnabled    bool   `json:"xmm_state_enabled"`
	YMMStateEnabled    bool   `json:"ymm_state_enabled"`
}

type CandidatePreflightReceipt struct {
	Schema                string      `json:"schema"`
	ObservedAt            time.Time   `json:"observed_at"`
	ExecutableSHA256      string      `json:"executable_sha256"`
	PreflightFunction     string      `json:"preflight_function"`
	Observation           Observation `json:"observation"`
	Compatible            bool        `json:"compatible"`
	Decision              string      `json:"decision"`
	SU2ExecutionAttempted bool        `json:"su2_execution_attempted"`
}

// These instructions are implemented in cpu_windows_amd64.s. They read the
// processor directly and are intentionally not replaceable by package hooks.
func cpuid(eax, ecx uint32) (a, b, c, d uint32)
func xgetbv(index uint32) (eax, edx uint32)

func ObserveNative() (Observation, error) {
	maximum, vendorB, vendorC, vendorD := cpuid(0, 0)
	if maximum < 1 {
		return Observation{}, errors.New("native CPUID basic feature leaf is unavailable")
	}
	vendorBytes := make([]byte, 12)
	binary.LittleEndian.PutUint32(vendorBytes[0:4], vendorB)
	binary.LittleEndian.PutUint32(vendorBytes[4:8], vendorD)
	binary.LittleEndian.PutUint32(vendorBytes[8:12], vendorC)
	signature, _, leaf1ECX, _ := cpuid(1, 0)
	var leaf7EBX uint32
	if maximum >= 7 {
		_, leaf7EBX, _, _ = cpuid(7, 0)
	}
	xsave := leaf1ECX&(1<<26) != 0
	osxsave := leaf1ECX&(1<<27) != 0
	var xcr0 uint64
	if xsave && osxsave {
		low, high := xgetbv(0)
		xcr0 = uint64(high)<<32 | uint64(low)
	}
	observation := Observation{
		Schema: ObservationSchemaV1, VendorID: string(vendorBytes), MaximumBasicLeaf: maximum,
		ProcessorSignature: signature, Leaf1ECX: leaf1ECX, Leaf7EBX: leaf7EBX, XCR0: xcr0,
		AVX: leaf1ECX&(1<<28) != 0, AVX2: leaf7EBX&(1<<5) != 0,
		FMA: leaf1ECX&(1<<12) != 0, BMI1: leaf7EBX&(1<<3) != 0, BMI2: leaf7EBX&(1<<8) != 0,
		XSAVE: xsave, OSXSAVE: osxsave, HypervisorPresent: leaf1ECX&(1<<31) != 0,
		XMMStateEnabled: xcr0&(1<<1) != 0, YMMStateEnabled: xcr0&(1<<2) != 0,
	}
	return observation, observation.Validate()
}

func (observation Observation) Validate() error {
	if observation.Schema != ObservationSchemaV1 || len(observation.VendorID) != 12 ||
		strings.Trim(observation.VendorID, "\x00 ") == "" || observation.MaximumBasicLeaf < 1 {
		return errors.New("SU2 native host observation identity is invalid")
	}
	for _, character := range []byte(observation.VendorID) {
		if character < 0x20 || character > 0x7e {
			return errors.New("SU2 native host CPUID vendor id is not printable ASCII")
		}
	}
	want := Observation{
		Schema: observation.Schema, VendorID: observation.VendorID, MaximumBasicLeaf: observation.MaximumBasicLeaf,
		ProcessorSignature: observation.ProcessorSignature, Leaf1ECX: observation.Leaf1ECX,
		Leaf7EBX: observation.Leaf7EBX, XCR0: observation.XCR0,
		AVX: observation.Leaf1ECX&(1<<28) != 0, AVX2: observation.Leaf7EBX&(1<<5) != 0,
		FMA: observation.Leaf1ECX&(1<<12) != 0, BMI1: observation.Leaf7EBX&(1<<3) != 0,
		BMI2: observation.Leaf7EBX&(1<<8) != 0, XSAVE: observation.Leaf1ECX&(1<<26) != 0,
		OSXSAVE:           observation.Leaf1ECX&(1<<27) != 0,
		HypervisorPresent: observation.Leaf1ECX&(1<<31) != 0,
		XMMStateEnabled:   observation.XCR0&(1<<1) != 0, YMMStateEnabled: observation.XCR0&(1<<2) != 0,
	}
	if observation != want {
		return errors.New("SU2 native host feature flags do not match the captured CPUID/XCR0 registers")
	}
	if observation.MaximumBasicLeaf < 7 && observation.Leaf7EBX != 0 {
		return errors.New("SU2 native host observation includes unavailable CPUID leaf 7")
	}
	if (!observation.XSAVE || !observation.OSXSAVE) && observation.XCR0 != 0 {
		return errors.New("SU2 native host observation includes XCR0 without XSAVE and OSXSAVE")
	}
	return nil
}

func (observation Observation) Compatible() bool {
	return observation.AVX && observation.AVX2 && observation.FMA && observation.BMI1 && observation.BMI2 &&
		observation.XSAVE && observation.OSXSAVE && observation.XMMStateEnabled && observation.YMMStateEnabled
}

func (observation Observation) Missing() []string {
	requirements := []struct {
		name string
		ok   bool
	}{
		{"AVX", observation.AVX}, {"AVX2", observation.AVX2}, {"FMA", observation.FMA},
		{"BMI1", observation.BMI1}, {"BMI2", observation.BMI2}, {"XSAVE", observation.XSAVE},
		{"OSXSAVE", observation.OSXSAVE}, {"XMM state", observation.XMMStateEnabled},
		{"YMM state", observation.YMMStateEnabled},
	}
	missing := make([]string, 0, len(requirements))
	for _, requirement := range requirements {
		if !requirement.ok {
			missing = append(missing, requirement.name)
		}
	}
	return missing
}

func RequireNative() (Observation, error) {
	observation, err := ObserveNative()
	if err != nil {
		return Observation{}, fmt.Errorf("observe native SU2 host: %w", err)
	}
	if !observation.Compatible() {
		return observation, fmt.Errorf("SU2 win64-omp native preflight rejected this host; missing: %s", strings.Join(observation.Missing(), ", "))
	}
	return observation, nil
}

// CandidatePreflight executes the same preflight used by engineering.SU2NACA0012
// and binds its result to the currently executing candidate file.
func CandidatePreflight(executablePath string, observedAt time.Time) (CandidatePreflightReceipt, error) {
	hash, err := hashRegularFile(executablePath)
	if err != nil {
		return CandidatePreflightReceipt{}, fmt.Errorf("hash preflight executable: %w", err)
	}
	observation, observeErr := RequireNative()
	compatible := observeErr == nil
	decision := "allowed"
	if !compatible {
		decision = "rejected"
	}
	if observedAt.IsZero() {
		observedAt = time.Now()
	}
	receipt := CandidatePreflightReceipt{
		Schema: CandidatePreflightSchemaV1, ObservedAt: observedAt.UTC(), ExecutableSHA256: hash,
		PreflightFunction: PreflightFunctionV1, Observation: observation,
		Compatible: compatible, Decision: decision, SU2ExecutionAttempted: false,
	}
	return receipt, receipt.Validate()
}

func (receipt CandidatePreflightReceipt) Validate() error {
	if receipt.Schema != CandidatePreflightSchemaV1 || receipt.ObservedAt.IsZero() ||
		receipt.PreflightFunction != PreflightFunctionV1 || !validDigest(receipt.ExecutableSHA256) ||
		receipt.SU2ExecutionAttempted {
		return errors.New("SU2 candidate preflight identity or no-execution contract is invalid")
	}
	if err := receipt.Observation.Validate(); err != nil {
		return err
	}
	wantCompatible := receipt.Observation.Compatible()
	wantDecision := "rejected"
	if wantCompatible {
		wantDecision = "allowed"
	}
	if receipt.Compatible != wantCompatible || receipt.Decision != wantDecision {
		return errors.New("SU2 candidate preflight decision does not match its native observation")
	}
	return nil
}

func hashRegularFile(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("preflight executable is not a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(hash, file)
	closeErr := file.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return "", err
	}
	after, err := os.Lstat(path)
	if err != nil || written != info.Size() || after.Size() != info.Size() ||
		!after.ModTime().Equal(info.ModTime()) || !os.SameFile(info, after) {
		return "", errors.New("preflight executable changed while hashing")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func validDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == strings.ToLower(value)
}
