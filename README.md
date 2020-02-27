# vue-light-builder

Light Vue [vuejs.org] developement environment for light Vue projects.

## Features

* lightweight builder 
* supports: .vue, .js, .html, .css, .sass, .scss files, 
* css/js minifier
* live reload
* reverse proxy (ex. for REST API servers)
* automatically download missing vue packages from CDN
* require may be URL
* easy installation
* simple configuration
* no dependencies on webpack or babel

## Getting Started

### Create project

```
npm init
npm i -D vue-light-builder
npm run vue-light-create
npm run vue-light-live
```

### Executing program

* Init empty project with default settings
  ```
  vue-light-create
  ```
* Build minified project
  ```
  vue-light-build
  ```
* Server with livereload and reverse-proxy on http://localhost:3000
  ```
  vue-light-live -proxy=/restapi=http://localhost:8080/restapi
  ```

### Project structure (customizable)

```
[app]
|-- [assets]    // optional assets folder
|   |-- logo.png
|   |-- ...
|
|-- [components]
|   |-- component.vue
|   |-- ...
|
|-- [views]
|   |-- view.vue
|   |-- ...
|
|-- index.html  // main application file
|-- index.js    // js coresponding to [index].html
|-- App.vue     // main view
|-- ...
|
[public]        // public static files
|-- ...  
|
[dist]          // distribution files (autcreated)
|-- index.html
|-- index.js
|-- vendor.js
|-- ...
|
[build]         // intermediate build files (autocreated)
|-- index.html
|-- ...
|
```

Possible options for customization: 
  ```
  vue-light-live -help
  vue-light-build -help
  ```

## Author

Darius Kisonas <dariuski256@gmail.com>

## License

MIT
