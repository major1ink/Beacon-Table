package domain

// RollResult — результат одного броска: значения каждого кубика отдельно
// (чтобы показать их в логе, а не только сумму) плюс модификатор и итог.
type RollResult struct {
	Rolls    []int `json:"rolls"`
	Modifier int   `json:"modifier"`
	Total    int   `json:"total"`
}
