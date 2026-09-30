// btmod — проверка и упаковка модулей контента Beacon Table для репозитория
// модулей: тот же код, что разбирает модуль в программе (internal/module,
// internal/schema), поэтому проверка в CI совпадает с проверкой при
// установке.
//
//	btmod validate [--tag id/vX.Y.Z] [--prev-summary файл] <папка модуля>...
//	btmod pack -o <папка выпуска> <папка модуля>
//	btmod index -o index.json --base-url <корень загрузок> [--merge index.json] <папка выпуска>
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"beacon-table/internal/modtool"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

const usage = `использование:
  btmod validate [--tag id/vX.Y.Z] [--prev-summary файл] <папка модуля>...
  btmod pack -o <папка выпуска> <папка модуля>
  btmod index -o <index.json> --base-url <корень загрузок> [--merge <index.json>] <папка выпуска>
`

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = fmt.Fprint(stderr, usage)
		return 2
	}
	var err error
	switch args[0] {
	case "validate":
		return validate(args[1:], stdout, stderr)
	case "pack":
		err = pack(args[1:], stdout)
	case "index":
		err = index(args[1:], stdout)
	default:
		_, _ = fmt.Fprint(stderr, usage)
		return 2
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "ошибка:", err)
		return 1
	}
	return 0
}

func validate(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("validate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	tag := fs.String("tag", "", "тег выпуска id/vX.Y.Z — должен совпасть с module.json")
	prev := fs.String("prev-summary", "", "summary.json прошлой версии: пропавший slug — только с повышением major")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	dirs := fs.Args()
	if len(dirs) == 0 {
		_, _ = fmt.Fprint(stderr, usage)
		return 2
	}
	opts := modtool.Options{Tag: *tag}
	if *prev != "" {
		s, err := modtool.ReadSummary(*prev)
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "ошибка:", err)
			return 1
		}
		opts.Prev = s
	}
	failed := false
	for _, dir := range dirs {
		r := modtool.ValidateModule(dir, opts)
		for _, w := range r.Warnings {
			_, _ = fmt.Fprintf(stdout, "%s: предупреждение: %s\n", dir, w)
		}
		for _, e := range r.Errors {
			_, _ = fmt.Fprintf(stderr, "%s: ошибка: %s\n", dir, e)
		}
		if r.OK() {
			_, _ = fmt.Fprintf(stdout, "%s: ок\n", dir)
		} else {
			failed = true
		}
	}
	if len(dirs) > 1 {
		for _, p := range modtool.ValidateSet(dirs) {
			_, _ = fmt.Fprintln(stderr, "набор модулей: ошибка:", p)
			failed = true
		}
	}
	if failed {
		return 1
	}
	return 0
}

func pack(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("pack", flag.ContinueOnError)
	out := fs.String("o", "", "папка выпуска")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *out == "" || fs.NArg() != 1 {
		return fmt.Errorf("нужны -o и одна папка модуля")
	}
	r := modtool.ValidateModule(fs.Arg(0), modtool.Options{})
	if !r.OK() {
		for _, e := range r.Errors {
			_, _ = fmt.Fprintln(stdout, e)
		}
		return fmt.Errorf("модуль не прошёл проверку, упаковывать нечего")
	}
	p, err := modtool.PackModule(fs.Arg(0), *out)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "%s  %d байт  sha256 %s\n", p.Archive, p.Size, p.SHA256)
	return nil
}

func index(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("index", flag.ContinueOnError)
	out := fs.String("o", "", "куда писать index.json")
	base := fs.String("base-url", "", "корень загрузок выпусков")
	merge := fs.String("merge", "", "прежний index.json: модули вне выпуска остаются")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *out == "" || *base == "" || fs.NArg() != 1 {
		return fmt.Errorf("нужны -o, --base-url и одна папка выпуска")
	}
	var old *modtool.Index
	if *merge != "" {
		var err error
		if old, err = modtool.ReadIndex(*merge); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	idx, err := modtool.BuildIndex(fs.Arg(0), *base, old)
	if err != nil {
		return err
	}
	data, err := modtool.MarshalJSON(idx)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, data, 0o600); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "%s: модулей %d\n", *out, len(idx.Modules))
	return nil
}
