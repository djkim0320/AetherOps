//go:build windows

package cleanvmevidence

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"runtime"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const machineIdentityDomain = "aetherops-clean-vm-machine-identity-v1\x00"

func CaptureEnvironment(now time.Time) (VMEnvironment, error) {
	version := windows.RtlGetVersion()
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" || version.BuildNumber < 22000 {
		return VMEnvironment{}, errors.New("clean VM evidence requires Windows 11 x64")
	}
	machineGuid, err := registryString(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Cryptography`, "MachineGuid", registry.WOW64_64KEY)
	if err != nil || strings.TrimSpace(machineGuid) == "" {
		return VMEnvironment{}, errors.New("Windows MachineGuid is unavailable")
	}
	manufacturer, _ := registryString(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, "SystemManufacturer", 0)
	product, _ := registryString(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, "SystemProductName", 0)
	family, _ := registryString(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, "SystemFamily", 0)
	serial, _ := registryString(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, "SystemSerialNumber", 0)
	virtualization := virtualizationSignals(manufacturer, product, family)
	if len(virtualization) == 0 {
		return VMEnvironment{}, errors.New("host firmware identity does not prove an allowlisted virtual machine")
	}
	user, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return VMEnvironment{}, fmt.Errorf("open current process token: %w", err)
	}
	defer user.Close()
	tokenUser, err := user.GetTokenUser()
	if err != nil || tokenUser.User.Sid == nil {
		return VMEnvironment{}, errors.New("current Windows user SID is unavailable")
	}
	identity := domainHash(machineIdentityDomain, machineGuid, manufacturer, product, family, serial)
	sidHash := domainHash("aetherops-clean-vm-user-v1\x00", tokenUser.User.Sid.String())
	if now.IsZero() {
		now = time.Now()
	}
	return VMEnvironment{
		OS: "windows-11", Architecture: runtime.GOARCH,
		WindowsVersion: fmt.Sprintf("%d.%d.%d", version.MajorVersion, version.MinorVersion, version.BuildNumber),
		WindowsBuild:   version.BuildNumber, LogicalProcessors: runtime.NumCPU(),
		MachineIdentitySHA256: identity, CurrentUserSIDHash: sidHash,
		VMDetected: true, VirtualizationEvidence: virtualization, ObservedAt: now.UTC(),
	}, nil
}

func CaptureHostIdentity(now time.Time) (string, string, error) {
	version := windows.RtlGetVersion()
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" || version.BuildNumber < 22000 {
		return "", "", errors.New("host reference requires Windows 11 x64")
	}
	machineGuid, err := registryString(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Cryptography`, "MachineGuid", registry.WOW64_64KEY)
	if err != nil || strings.TrimSpace(machineGuid) == "" {
		return "", "", errors.New("Windows MachineGuid is unavailable")
	}
	manufacturer, _ := registryString(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, "SystemManufacturer", 0)
	product, _ := registryString(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, "SystemProductName", 0)
	family, _ := registryString(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, "SystemFamily", 0)
	serial, _ := registryString(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, "SystemSerialNumber", 0)
	return domainHash(machineIdentityDomain, machineGuid, manufacturer, product, family, serial),
		fmt.Sprintf("%d.%d.%d", version.MajorVersion, version.MinorVersion, version.BuildNumber), nil
}

func registryString(root registry.Key, path, name string, access uint32) (string, error) {
	key, err := registry.OpenKey(root, path, registry.QUERY_VALUE|access)
	if err != nil {
		return "", err
	}
	defer key.Close()
	value, _, err := key.GetStringValue(name)
	return strings.TrimSpace(value), err
}

func virtualizationSignals(values ...string) []string {
	joined := strings.ToLower(strings.Join(values, " "))
	known := map[string]string{
		"vmware":                "firmware:vmware",
		"virtualbox":            "firmware:virtualbox",
		"qemu":                  "firmware:qemu",
		"kvm":                   "firmware:kvm",
		"xen":                   "firmware:xen",
		"parallels":             "firmware:parallels",
		"amazon ec2":            "platform:amazon-ec2",
		"google compute engine": "platform:google-compute-engine",
	}
	var result []string
	if strings.Contains(joined, "microsoft corporation") && strings.Contains(joined, "virtual machine") {
		result = append(result, "firmware:microsoft-hyper-v")
	}
	for token, signal := range known {
		if strings.Contains(joined, token) {
			result = append(result, signal)
		}
	}
	sort.Strings(result)
	return result
}

func domainHash(domain string, values ...string) string {
	digest := sha256.New()
	_, _ = digest.Write([]byte(domain))
	for _, value := range values {
		_, _ = digest.Write([]byte(strings.TrimSpace(value)))
		_, _ = digest.Write([]byte{0})
	}
	return hex.EncodeToString(digest.Sum(nil))
}
