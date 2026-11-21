### Include configuration error details in settings check

When app loading or startup validation fails, `settings check` appends
the error's nonempty string cause in parentheses if it is at most 300
characters. This lets startup assertions identify which field to edit.
