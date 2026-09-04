package excalidraw

import (
	"errors"
	"unicode/utf16"
)

// lzstring.go — распаковка формата lz-string (compressToBase64), которым
// плагин Excalidraw для Obsidian сжимает рисунок внутри .excalidraw.md.
//
// Зачем это здесь. В ваулте нет ни одного файла с несжатым рисунком: все
// десять, что удалось посмотреть, лежат блоком ```compressed-json. То есть
// без этой распаковки импорт не прочитает вообще ничего — это не редкий
// случай, а единственный.
//
// Порт эталонного алгоритма lz-string 1.4.4 (MIT, Pieroxy). Читается тяжело
// и переписан почти буквально сознательно: это битовый формат, любое
// «улучшение по ходу» тут превращается в молча неверный результат на
// какой-нибудь одной записи из тысячи.
//
// Обратной операции (сжатия) намеренно нет. Она нужна только чтобы ЗАПИСАТЬ
// сжатый файл, а свои доски мы пишем несжатым блоком ```json — плагин
// понимает и такой (у него в настройках есть тумблер сжатия, а в самом файле
// написано, что данные можно разжать командой палитры). Несжатый вариант ещё
// и по-человечески диффится в git и в ваулте, чего про base64-простыню не
// скажешь.

// keyStrBase64 — алфавит lz-string. Не стандартный base64 из encoding/base64:
// значения тут 6-битные индексы в этой строке, а не байты, и стандартный
// декодер к ним неприменим.
const keyStrBase64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="

// ErrBadCompressed — вход не разбирается как lz-string.
var ErrBadCompressed = errors.New("не удалось разжать данные рисунка")

// DecompressFromBase64 разжимает строку, сжатую lz-string compressToBase64.
// Результат — UTF-8; сам алгоритм оперирует UTF-16, поэтому в конце
// собранные code units переводятся честной utf16.Decode (иначе эмодзи и
// прочие суррогатные пары развалились бы).
func DecompressFromBase64(input string) (string, error) {
	if input == "" {
		return "", nil
	}
	idx := make(map[byte]int, len(keyStrBase64))
	for i := 0; i < len(keyStrBase64); i++ {
		idx[keyStrBase64[i]] = i
	}
	src := []byte(input)
	get := func(i int) int {
		if i < 0 || i >= len(src) {
			return 0
		}
		v, ok := idx[src[i]]
		if !ok {
			return 0
		}
		return v
	}
	out, err := decompress(len(src), 32, get)
	if err != nil {
		return "", err
	}
	return string(utf16.Decode(out)), nil
}

// decompress — тело алгоритма. length — сколько значений во входе,
// resetValue — сколько бит несёт одно значение (32 = 1<<5 для base64-варианта
// с 6 битами... нет: resetValue это стартовая маска позиции бита, 32 = 1<<5,
// то есть 6 бит на значение), getNextValue — очередное значение входа.
func decompress(length, resetValue int, getNextValue func(int) int) ([]uint16, error) {
	var (
		dictionary  = make(map[int][]uint16, 64)
		enlargeIn   = 4
		dictSize    = 4
		numBits     = 3
		result      []uint16
		dataVal     = getNextValue(0)
		dataPos     = resetValue
		dataIndex   = 1
		readBitsErr error
	)
	// Первые три словарные позиции в формате зарезервированы (0/1/2 — это
	// команды «символ 8 бит», «символ 16 бит», «конец потока»).
	for i := 0; i < 3; i++ {
		dictionary[i] = []uint16{uint16(i)}
	}

	readBits := func(maxpower int) int {
		bits, power := 0, 1
		for power != maxpower {
			resb := dataVal & dataPos
			dataPos >>= 1
			if dataPos == 0 {
				dataPos = resetValue
				if dataIndex > length {
					readBitsErr = ErrBadCompressed
					return bits
				}
				dataVal = getNextValue(dataIndex)
				dataIndex++
			}
			if resb > 0 {
				bits |= power
			}
			power <<= 1
		}
		return bits
	}

	var c []uint16
	switch readBits(4) {
	case 0:
		c = []uint16{uint16(readBits(1 << 8))}
	case 1:
		c = []uint16{uint16(readBits(1 << 16))}
	case 2:
		return nil, nil // пустая строка на входе — это валидный результат
	default:
		return nil, ErrBadCompressed
	}
	if readBitsErr != nil {
		return nil, readBitsErr
	}
	dictionary[3] = c
	w := c
	result = append(result, c...)

	for {
		if dataIndex > length {
			return nil, ErrBadCompressed
		}
		cc := readBits(1 << numBits)
		if readBitsErr != nil {
			return nil, readBitsErr
		}
		switch cc {
		case 0:
			dictionary[dictSize] = []uint16{uint16(readBits(1 << 8))}
			dictSize++
			cc = dictSize - 1
			enlargeIn--
		case 1:
			dictionary[dictSize] = []uint16{uint16(readBits(1 << 16))}
			dictSize++
			cc = dictSize - 1
			enlargeIn--
		case 2:
			return result, nil // конец потока — единственный нормальный выход
		}
		if readBitsErr != nil {
			return nil, readBitsErr
		}
		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}

		var entry []uint16
		if e, ok := dictionary[cc]; ok {
			entry = e
		} else if cc == dictSize {
			// Классический для LZW случай «код ссылается на запись, которую
			// он же и создаёт»: w плюс первый символ самого w.
			entry = append(append([]uint16{}, w...), w[0])
		} else {
			return nil, ErrBadCompressed
		}
		result = append(result, entry...)

		dictionary[dictSize] = append(append([]uint16{}, w...), entry[0])
		dictSize++
		enlargeIn--
		w = entry
		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}
	}
}
