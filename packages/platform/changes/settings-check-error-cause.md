### Include configuration error details in settings check

When app loading or startup validation fails, `settings check` appends
the error's nonempty, single-line string cause in parentheses when it has at
most 300 characters and contains no control characters. This lets startup
assertions identify which field to edit.
