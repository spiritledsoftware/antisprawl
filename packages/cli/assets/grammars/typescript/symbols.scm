(function_declaration
  name: (identifier) @name) @symbol

(generator_function_declaration
  name: (identifier) @name) @symbol

(method_definition
  name: (_) @name) @symbol

(variable_declarator
  name: (identifier) @name
  value: [
    (function_expression)
    (generator_function)
    (arrow_function)
  ] @symbol)

(pair
  key: [
    (property_identifier)
    (private_property_identifier)
    (computed_property_name)
    (string)
  ] @name
  value: [
    (function_expression)
    (generator_function)
    (arrow_function)
  ] @symbol)

(public_field_definition
  name: [
    (property_identifier)
    (private_property_identifier)
    (computed_property_name)
  ] @name
  value: [
    (function_expression)
    (generator_function)
    (arrow_function)
  ] @symbol)

(function_signature
  name: (identifier) @name) @symbol

(method_signature
  name: (_) @name) @symbol

(abstract_method_signature
  name: (_) @name) @symbol

(property_signature
  name: (_) @name
  type: (type_annotation (function_type))) @symbol

(ambient_declaration
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      type: (type_annotation (function_type))) @symbol))
