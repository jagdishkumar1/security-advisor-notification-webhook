 var path = require('path');
 module.exports = {
   entry: './src/index.js',
   output: {
     path: path.resolve(__dirname, 'dist'),
     filename: 'bundle.js'
   },
   target: 'node',
   module: {
    rules: [
      {
        test: /\.js$/,
        loader: 'babel-loader'
      }
    ]
  }
 };
