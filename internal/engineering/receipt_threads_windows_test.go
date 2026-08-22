//go:build windows && amd64

package engineering

import "testing"

func TestReceiptThreadsMatchAdapterExecution(t *testing.T) {
	service := &Service{threads: 8}
	for _, test := range []struct {
		operation string
		want      int
	}{
		{operation: "openvsp_wing_aero", want: 8},
		{operation: "openvsp_modify_wing", want: 8},
		{operation: "gmsh_wing_mesh", want: 8},
		{operation: "su2_naca0012", want: 8},
		{operation: "xfoil_polar", want: 1},
	} {
		t.Run(test.operation, func(t *testing.T) {
			if got := service.receiptThreads(test.operation); got != test.want {
				t.Fatalf("receipt threads = %d, want %d", got, test.want)
			}
		})
	}
}
