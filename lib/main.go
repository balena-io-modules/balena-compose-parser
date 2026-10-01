package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/compose-spec/compose-go/v2/cli"
	"github.com/compose-spec/compose-go/v2/loader"
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
  --host-env            Trust the compose file, letting it read this process's environment and the
                        files it names in env_file, label_file, include and extends.file. Only pass
                        this for a compose file written by whoever is running us.

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

	// Run the load in a goroutine
	go func() {
		if !hostEnv {
			project, err := loadUntrusted(ctx, options, projectName, skipInterpolation)
			resultChan <- loadResult{project: project, err: err}
			return
		}

		project, err := options.LoadProject(ctx)
		resultChan <- loadResult{project: project, err: err}
	}()

	// Wait for either the result or timeout
	var project *types.Project
	select {
	case result := <-resultChan:
		if errors.Is(result.err, errSecondaryFile) {
			outputError("ValidationError", result.err.Error())
			os.Exit(1)
		}
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

var errSecondaryFile = errors.New("secondary file references are not allowed in an untrusted compose file")

// loadUntrusted reads the compose files once, refuses any that name a file
// compose-go would go on to read, and builds the project from what it already
// read. Reading a second time would leave a window for the file to change
// between the check and the load.
//
// SkipInclude and SkipExtends leave those keys in the model unfollowed, which is
// what lets us see them. Skipping them costs nothing here because a file that
// uses either is refused anyway.
func loadUntrusted(
	ctx context.Context,
	options *cli.ProjectOptions,
	projectName string,
	skipInterpolation bool,
) (*types.Project, error) {
	workingDir, err := options.GetWorkingDir()
	if err != nil {
		return nil, err
	}

	configDetails, err := options.ReadConfigFiles(ctx, workingDir, options)
	if err != nil {
		return nil, err
	}

	common := func(o *loader.Options) {
		o.SkipInterpolation = skipInterpolation
		o.Profiles = []string{"*"}
		o.SetProjectName(projectName, true)
	}

	// Look at the model with include and extends unfollowed, so the keys are
	// still visible to inspect.
	model, err := loader.LoadModelWithContext(ctx, *configDetails, common,
		func(o *loader.Options) {
			o.SkipInclude = true
			o.SkipExtends = true
		})
	if err != nil {
		return nil, err
	}

	if err := rejectSecondaryFiles(model); err != nil {
		return nil, err
	}

	// Then load for real from the same already-read content. extends is applied
	// this time, since a service may extend another in the same file, which reads
	// nothing. Only extends.file and include reach the filesystem, and both were
	// refused above.
	return loader.LoadWithContext(ctx, *configDetails, common)
}

// rejectSecondaryFiles errors if the model names a file compose-go would read.
//
// This holds for a single compose file. Given more than one, a later file can
// erase an include with !reset after an earlier file has already been loaded and
// followed, because include is resolved while each file loads rather than after
// the merge, so it would not show up here. The builder passes one file. Anything
// passing several and relying on this should check each file itself.
func rejectSecondaryFiles(model map[string]any) error {
	if namesPath(model["include"]) {
		return fmt.Errorf("%w: include", errSecondaryFile)
	}

	services, _ := model["services"].(map[string]any)
	for _, name := range slices.Sorted(maps.Keys(services)) {
		service, _ := services[name].(map[string]any)
		for _, key := range []string{"env_file", "label_file"} {
			if namesPath(service[key]) {
				return fmt.Errorf("%w: services.%s.%s", errSecondaryFile, name, key)
			}
		}
		extends, _ := service["extends"].(map[string]any)
		if namesPath(extends["file"]) {
			return fmt.Errorf("%w: services.%s.extends.file", errSecondaryFile, name)
		}
	}

	return nil
}

// namesPath reports whether a field could hold a path. An empty list does not.
func namesPath(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case string:
		return v != ""
	case []any:
		return len(v) > 0
	case map[string]any:
		return len(v) > 0
	default:
		return true
	}
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
