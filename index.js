const url          = require('url');
const tcp          = require('net');
const util         = require('util');
const SSDP         = require('ssdp2');
const EventEmitter = require('events');

/**
 * debug
 */
console.debug = util.debuglog('yeelight');

/**
 * Yeelight
 * @class
 * @docs http://www.yeelight.com/download/Yeelight_Inter-Operation_Spec.pdf
 * @param {String} address address of yeelight device
 * @param {Number} port port of yeelight device
 * @return {Yeelight} Instance of Yeelight 
 */
function Yeelight(address, port){
  var u = url.parse(address);
  if(u.protocol === 'yeelight:'){
    address = u.hostname;
    port    = u.port;
  }
  if(!(this instanceof Yeelight)){
    console.debug('creating new instance of Yeelight with addr & port', address, port)
    return new Yeelight(address, port);
  }
  var buffer = '';
  port = port || 55443;
  EventEmitter.call(this);
  this.queue = {};
  this.socket = new tcp.Socket();
  this.socket
  .on('data', function(chunk){
    buffer += chunk;
    buffer.split(/\r\n/g).filter(function(line){
      return !!line;
    }).forEach(this.parse.bind(this));
    buffer = '';
  }.bind(this))
  .on('error', function(err){
    this.connected = false;
    this.emit('error', err);
    this.emit('disconnect', this);
  }.bind(this))
  .on('end', function(){
    this.connected = false;
    this.emit('disconnect', this);
  }.bind(this))
  .connect(port, address, function(err){
    this.connected = true;
    this.sync().then(function(){
      this.emit('connect', this);
    }.bind(this));
  }.bind(this));
  return this;
};

Yeelight.prototype.close = function(){
  this.socket.end();
  this.socket.destroy();
}

/**
 * Yeelight extends EventEmitter
 */
util.inherits(Yeelight, EventEmitter);

/**
 * Search Yeelight blub
 * @param {Number} port ssdp port
 * @param {Function} callback handle your device
 * @return {SSDP} ssdp instance
 * 
 * @example
 * 
 * Yeelight.discover(function(light){
 *  console.log(light.name);
 * });
 */
Yeelight.discover = function(port, callback) {
  // TODO: `port` will rename to `opts` in next major version, then add `timeout` to opts
  if(typeof port === 'function'){
    callback = port; port = null;
  }
  const yeelights = [];
  const discover = new SSDP({ port: port || 1982 });
  discover.on('response', function(response) {
    console.debug(response.headers);
    const { 
      id, name, model, support,
      color_mode, fw_ver,
      Location: address, 
    } = response.headers;
    if(address && (!~yeelights.indexOf(address))){
      console.debug('received response from', address);
      yeelights.push(address);
      var yeelight = new Yeelight( address );
      yeelight.id = id;
      yeelight.model = model;
      yeelight.address = address;
      yeelight.firmware_version = fw_ver;
      yeelight.supports = support && support.split(' ') || [];
      yeelight.on('connect', function(){
        callback.call(discover, this, response);
      });
    };
  });
  console.debug('start finding ...');
  return discover.search('wifi_bulb');
};

/**
 * Find Yeelight blub
 */
Yeelight.find = (opts = {}) => {
  const { timeout = 12000 } = opts;
  return new Promise((accept, reject) => {
    const discover = Yeelight.discover(yeelight => {
      clearTimeout(timer);
      accept(yeelight);
      discover.close();
    });
    var timer = setTimeout(() => {
      discover.close();
      reject(new Error('timeout'));
    }, timeout);
  });
};

/**
 * is_support("set_rgb")
 * @param {String} func
 * @return {Boolean} isSupport
 */
Yeelight.prototype.is_support = function(func){
  return !!~this.supports.indexOf(func);
};

/**
 * Current support property and it's possible value is defined as below 
 * @type {Array}
 */
Yeelight.prototype.props = [
  // The name of the device set by “set_name” command
  "name",
  // on: smart LED is turned on / off: smart LED is turned off
  "power", 
  // Brightness percentage. Range 1 ~ 100
  "bright",
  // Color temperature. Range 1700 ~ 6500(k)
  "ct", 
  // Color. Range 1 ~ 16777215
  "rgb", 
  // Hue. Range 0 ~ 359
  "hue", 
  // Saturation. Range 0 ~ 100
  "sat", 
  // 1: rgb mode / 2: color temperature mode / 3: hsv mode
  "color_mode",
  // The remaining time of a sleep timer. Range 1 ~ 60 (minutes)
  "delayoff",
  // 0: no flow is running / 1:color flow is running
  "flowing", 
  // Current flow parameters (only meaningful when 'flowing' is 1)
  "flow_params", 
  // 1: Music mode is on / 0: Music mode is off
  "music_on", 
  // Background light power status
  "bg_power", 
  // Background light is flowing
  "bg_flowing",
  // Current flow parameters of background light
  "bg_flow_params", 
  // Color temperature of background light
  "bg_ct", 
  // 1: rgb mode / 2: color temperature mode / 3: hsv mode
  "bg_lmode",
  // Brightness percentage of background light
  "bg_bright", 
  // Color of background light
  "bg_rgb", 
  // Hue of background light
  "bg_hue", 
  // Saturation of background light
  "bg_sat",
  // Brightness of night mode light
  "nl_br", 
  // 0: daylight mode / 1: moonlight mode (ceiling light only)
  // "active_mode"
];

/**
 * [sync description]
 * @return {Promise} Yeelight Instance
 */
Yeelight.prototype.sync = function(){
  return this.get_prop.apply(this, this.props)
  .then(function(res){
    Object.keys(res).forEach(function(key){
      this[ key ] = res[ key ];
    }.bind(this));
    return res;
  }.bind(this));
};

/**
 * Parse Yeelight Response
 * @param {String} data
 * @return {Yeelight} Yeelight Instance
 */
Yeelight.prototype.parse = function(data){
  console.debug('->', data);
  var yl = this;
  function parseResult(result) {
    var message = JSON.parse(result);
    if(message.method === 'props'){
      Object.keys(message.params).forEach(function(key){
	      yl[ key ] = message.params[ key ];
      }.bind(yl));
    }
    yl.emit(message.method, message.params, message);
    if(typeof yl.queue[ message.id ] === 'function'){
      yl.queue[ message.id ](message);
      yl.queue[ message.id ] = null;
      delete yl.queue[ message.id ];
    }
  }
  var results = data.toString().replace("}{","}}{{").split("}{");
  for (i = 0; i < results.length; i++) {
    parseResult(results[i]);
  }
  return this;
};

/**
 * execute command
 * @param  {String} method The value of "method" is a string that specifies which control method the sender wants to
 *                         invoke. The value must be chosen by sender from one of the methods that listed in 
 *                         "SUPPORT" header in advertisement request or search response message. Otherwise, the 
 *                         message will be rejected by smart LED.
 * @param  {String} params The value of "params" is an array. The values in the array are method specific. 
 * @return {Promise} promise
 */
Yeelight.prototype.command = function(method, params) {
  params = [].slice.call(params || []);
  const id = (Math.random() * 1e3) & 0xff;
  const request = { id, method, params };
  const message = JSON.stringify(request);

  const self = this;

  const promise = new Promise((resolve, reject) => {
    let responded = false;

    const timeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        delete self.queue[id];
        const error = new Error('Network timeout, Yeelight did not respond');
        self.emit('error', error);
        // Optionally, resolve with null or a default value
        resolve(null);
      }
    }, 3000);

    self.queue[id] = function(res) {
      if (responded) return;
      responded = true;
      clearTimeout(timeout);
      delete self.queue[id];

      if (res && res.error) {
        const error = new Error(res.error.message || 'Unknown error');
        self.emit('error', error);
        resolve(null);
      } else {
        resolve(res);
      }
    };

    self.socket.write(message + '\r\n', function(err) {
      if (err && !responded) {
        responded = true;
        clearTimeout(timeout);
        delete self.queue[id];
        const error = new Error('Socket write error: ' + err.message);
        self.emit('error', error);
        resolve(null);
      }
    });
  });

  return promise;
};


/**
 * get_prop
 * This method is used to retrieve current property of smart LED.
 * All the supported properties are defined in table 4-2, section 4.3
 * @param {...*} props The parameter is a list of property names and the response contains a
 * list of corresponding property values. If the requested property name is not recognized by
 * smart LED, then a empty string value ("") will be returned. 
 *
 * @returns {Promise} see {@link Yeelight#command} 
 * 
 * @example
 *
 * Request:
 * {"id":1,"method":"get_prop","params":["power", "not_exist", "bright"]}
 *
 * Response:
 * {"id":1, "result":["on", "", "100"]}
 * 
 */
Yeelight.prototype.get_prop = function (prop1, prop2, propN) {
  const props = [].concat.apply([], arguments);
  return this.command('get_prop', props).then(function (res) {
    // check if res and res.result are valid
    if (!res || !Array.isArray(res.result)) {
      const error = new Error('Invalid or empty response from Yeelight device');
      // throw, return null, or return an object with undefined values
      // Option 1: return an object with undefined values for all props
      return props.reduce(function (acc, name) {
        acc[name] = undefined;
        return acc;
      }, {});
    }

    return props.reduce(function (acc, name, index) {
      acc[name] = res.result[index];
      return acc;
    }, {});
  });
};

/**
 * set_name This method is used to name the device. The name will be stored on the
 *          device and reported in discovering response. 
 *          User can also read the name through {@link Yeelight#get_prop}  method.
 * <p>
 * When using Yeelight official App, the device name is stored on cloud.
 * This method instead store the name on persistent memory of the device, so the two names
 * could be different.
 * </p>
 * @param {String} name the name of the device.
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.set_name = function (name){
  return this.command('set_name', [ name ]);
};

/**
 * set_ct_abx
 * This method is used to change the color temperature of a smart LED
 * 
 * @param {Number} ct_value is the target color temperature. The type is integer and 
 *                 range is 1700 ~ 6500 (k).
 * @param {String} effect support two values: "sudden" and "smooth". If effect is "sudden",
 *               then the color temperature will be changed directly to target value, under this case, the
 *               third parameter "duration" is ignored. If effect is "smooth", then the color temperature will
 *               be changed to target value in a gradual fashion, under this case, the total time of gradual
 *               change is specified in third parameter "duration".
 * @param {Number} duration specifies the total time of the gradual changing. The unit is
 *                 milliseconds. The minimum support duration is 30 milliseconds.
 * 
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.set_ct_abx = function (ct_value, effect, duration){
  ct_value = Math.max(1700, Math.min(+ct_value || 3500, 6500));
  return this.command('set_ct_abx', [ ct_value, effect || 'smooth', duration || 500 ]);
};

/**
 * set_rgb This method is used to change the color of a smart LED.
 * @param rgb_value is the target color, whose type is integer. It should be
 *                  expressed in decimal integer ranges from 0 to 16777215 (hex: 0xFFFFFF).
 * @param {String} effect    [Refer to {@link Yeelight#set_ct_abx} method.]
 * @param {Number} duration  [Refer to {@link Yeelight#set_ct_abx} method.]
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.set_rgb = function (rgb_value, effect, duration){
  rgb_value = Math.max(0, Math.min(+rgb_value, 0xffffff));
  return this.command('set_rgb', [ rgb_value, effect || 'smooth', duration || 500 ]);
};

/**
 * [set_hsv This method is used to change the color of a smart LED]
 * @param {Number} hue is the target hue value, whose type is integer. 
 *                 It should be expressed in decimal integer ranges from 0 to 359.
 * @param {Number} sat is the target saturation value whose type is integer. It's range is 0 to 100
 * @param {Striung} effect   [Refer to {@link Yeelight#set_ct_abx} method.]
 * @param {Number} duration [Refer to {@link Yeelight#set_ct_abx} method.]
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.set_hsv = function (hue, sat, effect, duration){
  hue = Math.max(0, Math.min(+hue, 359));
  sat = Math.max(0, Math.min(+sat, 100));
  return this.command('set_hsv', [ hue, sat, effect || 'smooth', duration || 500 ]);
};

/**
 * set_bright This method is used to change the brightness of a smart LED.
 * @param brightness is the target brightness. The type is integer and ranges
 *                   from 1 to 100. The brightness is a percentage instead of a absolute value. 
 *                   100 means maximum brightness while 1 means the minimum brightness. 
 * @param {String} effect     [Refer to {@link Yeelight#set_ct_abx} method.]
 * @param {Number} duration   [Refer to {@link Yeelight#set_ct_abx} method.]
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.set_bright = function (brightness, effect, duration){
  brightness = Math.max(1, Math.min(+brightness, 100));
  return this.command('set_bright', [ brightness, effect || 'smooth', duration || 500 ]);
};

/**
 * set_power This method is used to switch on or off the smart LED (software managed on/off).
 * @param power can only be "on" or "off". 
*              <li>"on"  means turn on the smart LED,
*              <li>"off" means turn off the smart LED. 
 * @param {String} effect   [description]
 * @param {Number} duration [description]
 * @param {Number} mode [description]
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.set_power = function (power, effect, duration, mode) {
  power =  ~[ 1, true, '1','on' ].indexOf(power) ? 'on' : 'off';
  return this.command('set_power', [ power, effect || 'smooth', duration || 500 , mode || 0 ]);
};

/**
 * toggle This method is used to toggle the smart LED.
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.toggle = function (){
  return this.command('toggle');
};

/**
 * set_default This method is used to save current state of smart LED in persistent
 *              memory. So if user powers off and then powers on the smart LED again (hard power reset),
 *              the smart LED will show last saved state.
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.set_default = function (){
  return this.command('set_default', arguments);
};

/**
 * This method is used to start a color flow. Color flow is a series of smart
 * LED visible state changing. It can be brightness changing, color changing or color
 * temperature changing.This is the most powerful command. All our recommended scenes,
 * e.g. Sunrise/Sunset effect is implemented using this method. With the flow expression, user
 * can actually “program” the light effect.
 * @param {Number} count is the total number of visible state changing before color flowstopped. 
 * 0 means infinite loop on the state changing.
 * @param {Number} action is the action taken after the flow is stopped. 
 * <li>0 means smart LED recover to the state before the color flow started.
 * <li>1 means smart LED stay at the state when the flow is stopped.
 * <li>2 means turn off the smart LED after the flow is stopped.
 * @param {String} flow_expression is the expression of the state changing series.
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.start_cf = function (count, action, flow_expression){
  return this.command('start_cf', arguments);
};
/**
 * stop_cf This method is used to stop a running color flow.
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.stop_cf = function (){
  return this.command('stop_cf');
};
/**
 * set_scene This method is used to set the smart LED directly to specified state. If
 *           the smart LED is off, then it will turn on the smart LED firstly and then apply the specified
 *           command.
 * @param {String} type can be "color", "hsv", "ct", "cf", "auto_dealy_off". 
 * <li>"color" means change the smart LED to specified color and brightness.
 * <li>"hsv" means change the smart LED to specified color and brightness.
 * <li>"ct" means change the smart LED to specified ct and brightness.
 * <li>"cf" means start a color flow in specified fashion.
 * <li>"auto_delay_off" means turn on the smart LED to specified brightness and start a sleep timer to turn off the light after the specified minutes.
 * "val1", "val2", "val3" are class specific.
 * @param {...Number} value 
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.set_scene = function (type, val, val2, val3){
  return this.command('set_scene', arguments);
};
/**
 * [cron_add description]
 * @param {Number} type  [description]
 * @param {Number} value [description]
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.cron_add = function (type, value){
  return this.command('cron_add', arguments);
};
/**
 * [cron_get description]
 * @param {Number} type [description]
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.cron_get = function (type){
  return this.command('cron_get', arguments);
};
/**
 * [cron_del description]
 * @param {Number} type [description]
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.cron_del = function (type){
  return this.command('cron_del', arguments);
};
/**
 * This method is used to change brightness, CT or color of a smart LED
 * without knowing the current value, it's main used by controllers.
 * @param {String} action  the direction of the adjustment. The valid value can be:
 * “increase": increase the specified property
 * “decrease": decrease the specified property
 * “circle": increase the specified property, after it reaches the max value, go back to minimum value.
 * @param {String} prop the property to adjust. The valid value can be:
 * “bright": adjust brightness.
 * “ct": adjust color temperature.
 * “color": adjust color. 
 * (When “prop" is “color", the “action" can only be “circle", 
 * otherwise, it will be deemed as invalid request.)
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.set_adjust = function (action, prop){
  return this.command('set_adjust', [ action, prop ]);
};
/**
 * set_music This method is used to start or stop music mode on a device. 
 * Under music mode, no property will be reported and no message quota is checked.
 * <p>
 * When control device wants to start music mode, it needs start a TCP
 * server firstly and then call “set_music” command to let the device know the IP and Port of the
 * TCP listen socket. After received the command, LED device will try to connect the specified
 * peer address. If the TCP connection can be established successfully, then control device could
 * send all supported commands through this channel without limit to simulate any music effect.
 * The control device can stop music mode by explicitly send a stop command or just by closing
 * the socket.
 * </p>
 * 
 * @param {Number} action the action of set_music command. The valid value can be:
 * 0: turn off music mode.
 * 1: turn on music mode.
 * @param {String} host the IP address of the music server
 * @param {Number} port the TCP port music application is listening on.
 * @returns {Promise} see {@link Yeelight#command}
 */
Yeelight.prototype.set_music = function (action, host, port){
  action = action & 0xff;
  return this.command('set_music', arguments);
};

/**
 * Close Yeelight device
 * @return {Yeelight} Yeelight Instance
 */
Yeelight.prototype.exit = function(){
  this.socket.end();
  return this;
};

/**
 * These methods are used to control background light, for each command
 * detail, refer to set_xxx command.
 * 
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.bg_set = function(){
  return this.command(arguments);
};

/**
 * This method is used to toggle the main light and background light at the same time.
 * 
 * <p>
 * When there is main light and background light, “toggle” is used to toggle
 * main light, “bg_toggle” is used to toggle background light while “dev_toggle” is used to
 * toggle both light at the same time
 * </p>
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.dev_toggle = function(){
  return this.command('dev_toggle');
}
/**
 * This method is used to adjust the brightness by specified percentage
 * within specified duration.
 * @param {Number} percentage the percentage to be adjusted. The range is: -100 ~ 100
 * @param {Number} duration Refer to "set_ct_abx" method.
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.adjust_bright = function(percentage, duration){
  return this.command('adjust_bright', [ percentage, duration ]);
};

/**
 * This method is used to adjust the color temperature by specified
 * percentage within specified duration.
 * 
 * @param {Number} percentage the percentage to be adjusted. The range is: -100 ~ 100
 * @param {Number} duration Refer to "set_ct_abx" method.
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.adjust_ct = function(percentage, duration){
  return this.command('adjust_bright', [ percentage, duration ]);
};


/**
 * This method is used to adjust the color within specified duration.
 * 
 * @param {Number} percentage the percentage to be adjusted. The range is: -100 ~ 100
 * @param {Number} duration Refer to "set_ct_abx" method.
 * @returns {Promise} see {@link Yeelight#command} 
 */
Yeelight.prototype.adjust_color = function(percentage, duration){
  return this.command('adjust_bright', [ percentage, duration ]);
};

module.exports = Yeelight;
