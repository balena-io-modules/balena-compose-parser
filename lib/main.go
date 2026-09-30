package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/compose-spec/compose-go/v2/cli"
	"github.com/compose-spec/compose-go/v2/types"
	"github.com/sirupsen/logrus"
)

// ErrorResponse represents error output from the parser
type ErrorResponse struct {
	Error   bool   `json:"error"`
	Name    string `json:"name"`
	Message string `json:"message"`
}

// Usage message
const usage = `
Usage: balena-compose-parser -f <compose-file> [-f <compose-file>...] <project-name>

Parses one or more docker-compose files and outputs a structured response.

Arguments:
  -f <compose-file>  Path to a docker-compose file to parse (can be specified multiple times with later files overriding earlier ones)
  <project-name>     Name of the project to use for the parsed output. It is recommended to use a UUID, as any fields which include
                     the project name need to be removed for normalization into a compose acceptable by balena.

Flags:
  --skip-interpolation  Leave ${VARIABLE} references verbatim instead of substituting them.
  --host-env            Let the compose file read this process's environment. Only pass this when
                        the environment belongs to the person who wrote the compose file.

Example:
  balena-compose-parser -f docker-compose.yml -f docker-compose.override.yml my-project-name
`

func main() {
	if len(os.Args) < 4 {
		outputError("ArgumentError", usage)
		os.Exit(1)
	}

	// Format logs outputted from compose-go to JSON
	logrus.SetFormatter(&logrus.JSONFormatter{
		FieldMap: logrus.FieldMap{
			logrus.FieldKeyTime:  "time",
			logrus.FieldKeyLevel: "level",
			logrus.FieldKeyMsg:   "message",
		},
	})

	var composeFiles []string
	var projectName string
	skipInterpolation := false
	hostEnv := false

	// Flags work wherever they appear, and an unknown one is an error rather than
	// a project name.
	for i := 1; i < len(os.Args); i++ {
		switch arg := os.Args[i]; {
		case arg == "--skip-interpolation":
			skipInterpolation = true
		case arg == "--host-env":
			hostEnv = true
		case arg == "-f":
			if i+1 >= len(os.Args) {
				outputError("ArgumentError", "Missing file path after -f flag\n"+usage)
				os.Exit(1)
			}
			composeFiles = append(composeFiles, os.Args[i+1])
			i++
		case strings.HasPrefix(arg, "-"):
			outputError("ArgumentError", fmt.Sprintf("Unknown flag %s\n%s", arg, usage))
			os.Exit(1)
		case projectName != "":
			outputError("ArgumentError", fmt.Sprintf("Unexpected argument %s: the project name is already %s\n%s", arg, projectName, usage))
			os.Exit(1)
		default:
			projectName = arg
		}
	}

	// Validate we have at least one compose file and a project name
	if len(composeFiles) == 0 {
		outputError("ArgumentError", "At least one compose file must be specified with -f\n"+usage)
		os.Exit(1)
	}

	if projectName == "" {
		outputError("ArgumentError", "Project name is required\n"+usage)
		os.Exit(1)
	}

	// Create a timeout context - 10 seconds timeout for parsing
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	projectOptions := []cli.ProjectOptionsFn{}

	// Off by default, since a compose file can name any variable we hold and have
	// the value copied out. --skip-interpolation does not stop that, because a
	// valueless `environment: [FOO]` entry is resolved by name, not substitution.
	// WithDotEnv belongs here too, since a .env in the project is a file the
	// compose file brought with it.
	if hostEnv {
		projectOptions = append(projectOptions, cli.WithOsEnv, cli.WithDotEnv)
	}

	projectOptions = append(projectOptions,
		cli.WithName(projectName),
		// "*" keeps profiled services in the output; compose-go otherwise
		// filters them out and only marshals `profiles` for enabled services.
		cli.WithProfiles([]string{"*"}),
		cli.WithInterpolation(!skipInterpolation),
	)

	options, err := cli.NewProjectOptions(composeFiles, projectOptions...)
	if err != nil {
		outputError("ConfigError", fmt.Sprintf("Failed to create compose project options: %v", err))
		os.Exit(1)
	}

	// Channel to receive the result from the goroutine
	type loadResult struct {
		project *types.Project
		err     error
	}
	resultChan := make(chan loadResult, 1)

	// Run LoadProject in a goroutine
	go func() {
		project, err := options.LoadProject(ctx)
		resultChan <- loadResult{project: project, err: err}
	}()

	// Wait for either the result or timeout
	var project *types.Project
	select {
	case result := <-resultChan:
		if result.err != nil {
			outputError("ParseError", fmt.Sprintf("Failed to parse compose file: %v", result.err))
			os.Exit(1)
		}
		project = result.project
	case <-ctx.Done():
		outputError("TimeoutError", "Compose file parsing timed out after 10 seconds")
		os.Exit(1)
	}

	// Get JSON representation using project's MarshalJSON method
	projectJSON, err := project.MarshalJSON()
	if err != nil {
		outputError("ParseError", fmt.Sprintf("Failed to marshal compose project to JSON: %v", err))
		os.Exit(1)
	}

	// Output the parsed project directly to stdout
	os.Stdout.Write(projectJSON)
}

// Write a structured error response to stderr
func outputError(errorName, message string) {
	response := ErrorResponse{
		Error:   true,
		Name:    errorName,
		Message: message,
	}

	// Output to stderr for error handling in TypeScript
	json.NewEncoder(os.Stderr).Encode(response)
}
