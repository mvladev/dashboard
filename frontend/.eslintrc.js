// https://eslint.org/docs/user-guide/configuring

module.exports = {
  root: true,
  parser: 'babel-eslint',
  parserOptions: {
    sourceType: 'module'
  },
  env: {
    browser: true,
  },
  // https://github.com/standard/standard/blob/master/docs/RULES-en.md
  extends: [
    'standard',
    'plugin:lodash/recommended'
  ],
  // required to lint *.vue files
  plugins: [
    'html',
    'lodash'
  ],
  // add your custom rules here
  rules: {
    // allow async-await
    'generator-star-spacing': 'off',
    // allow debugger during development
    'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'off',
    // loash rules
    'lodash/prefer-lodash-method': [2, {ignoreMethods: [
      'map',
      'forEach',
      'filter',
      'find',
      'keys',
      'assign'
    ]}]
  }
}
