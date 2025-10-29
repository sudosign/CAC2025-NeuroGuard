// ESP32 Single MPU6050 with Bluetooth Low Energy (BLE)
// This code has been modified to use only one MPU6050 sensor and output
// a JSON string in the format: {"sensor":{"accel":{...},"gyro":{...}}}

#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// Create a single MPU6050 object
Adafruit_MPU6050 mpu;

// MPU6050 I2C address
#define MPU_ADDR 0x68  // AD0 = LOW

// I2C pins for ESP32
#define I2C_SDA 21  // Primary I2C bus
#define I2C_SCL 22

// BLE Server and Characteristic
BLEServer* pServer = NULL;
BLECharacteristic* pCharacteristic = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// UUIDs for BLE service and characteristic
#define SERVICE_UUID        "12345678-1234-1234-1234-123456789abc"
#define CHARACTERISTIC_UUID "87654321-4321-4321-4321-cba987654321"

// BLE Server Callbacks
class MyServerCallbacks: public BLEServerCallbacks {
   void onConnect(BLEServer* pServer) {
     deviceConnected = true;
     Serial.println("Device connected via BLE");
   };

   void onDisconnect(BLEServer* pServer) {
     deviceConnected = false;
     Serial.println("Device disconnected from BLE");
   }
};

// Function to configure the MPU6050 sensor
void configureMPU(Adafruit_MPU6050 &mpu) {
  // Configure accelerometer range
  mpu.setAccelerometerRange(MPU6050_RANGE_16_G);
  Serial.print("Sensor - Accelerometer range set to: ");
  
  switch (mpu.getAccelerometerRange()) {
  case MPU6050_RANGE_2_G:
    Serial.println("+-2G");
    break;
  case MPU6050_RANGE_4_G:
    Serial.println("+-4G");
    break;
  case MPU6050_RANGE_8_G:
    Serial.println("+-8G");
    break;
  case MPU6050_RANGE_16_G:
    Serial.println("+-16G");
    break;
  }
  
  // Configure gyroscope range
  mpu.setGyroRange(MPU6050_RANGE_2000_DEG);
  Serial.print("Sensor - Gyro range set to: ");
  
  switch (mpu.getGyroRange()) {
  case MPU6050_RANGE_250_DEG:
    Serial.println("+- 250 deg/s");
    break;
  case MPU6050_RANGE_500_DEG:
    Serial.println("+- 500 deg/s");
    break;
  case MPU6050_RANGE_1000_DEG:
    Serial.println("+- 1000 deg/s");
    break;
  case MPU6050_RANGE_2000_DEG:
    Serial.println("+- 2000 deg/s");
    break;
  }
  
  // Configure filter bandwidth
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  Serial.print("Sensor - Filter bandwidth set to: ");
  
  switch (mpu.getFilterBandwidth()) {
  case MPU6050_BAND_260_HZ:
    Serial.println("260 Hz");
    break;
  case MPU6050_BAND_184_HZ:
    Serial.println("184 Hz");
    break;
  case MPU6050_BAND_94_HZ:
    Serial.println("94 Hz");
    break;
  case MPU6050_BAND_44_HZ:
    Serial.println("44 Hz");
    break;
  case MPU6050_BAND_21_HZ:
    Serial.println("21 Hz");
    break;
  case MPU6050_BAND_10_HZ:
    Serial.println("10 Hz");
    break;
  case MPU6050_BAND_5_HZ:
    Serial.println("5 Hz");
    break;
  }
}

void setup(void) {
  Serial.begin(115200);
  
  // Initialize the single I2C bus
  Wire.begin(I2C_SDA, I2C_SCL);
  
  Serial.println("ESP32 Single-MPU6050 BLE Test!");
  
  // Initialize BLE
  BLEDevice::init("ESP32_MPU6050_BLE");
  BLEDevice::setMTU(512);
  Serial.println("ESP32 BLE MAC Address: " + String(BLEDevice::getAddress().toString().c_str()));
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  // Create BLE Service
  BLEService *pService = pServer->createService(SERVICE_UUID);

  // Create BLE Characteristic
  pCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID,
                      BLECharacteristic::PROPERTY_READ |
                      BLECharacteristic::PROPERTY_WRITE |
                      BLECharacteristic::PROPERTY_NOTIFY
                    );

  pCharacteristic->addDescriptor(new BLE2902());

  // Start the service
  pService->start();

  // Start advertising
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(false);
  pAdvertising->setMinPreferred(0x0);
  BLEDevice::startAdvertising();
  Serial.println("BLE device is now advertising as 'ESP32_MPU6050_BLE'");

  delay(100);

  // Initialize the single MPU6050 sensor
  Serial.println("\nInitializing MPU6050 sensor...");
  
  if (!mpu.begin(MPU_ADDR, &Wire)) {
    Serial.println("Failed to find MPU6050 Sensor at address 0x68");
    while(1) {
      delay(10);
    }
  } else {
    Serial.println("MPU6050 Sensor Found at 0x68!");
    configureMPU(mpu);
  }

  Serial.println("\nReady to send data via BLE!");
  Serial.println("");
  delay(100);
}

void loop() {
  sensors_event_t a, g, temp;
  
  // Get new sensor event values
  mpu.getEvent(&a, &g, &temp);

  // Build the JSON string with the requested format
  String jsonData = "{\"sensor\":{\"accel\":{\"x\":" + String(a.acceleration.x, 2) + ",";
  jsonData += "\"y\":" + String(a.acceleration.y, 2) + ",";
  jsonData += "\"z\":" + String(a.acceleration.z, 2) + "},";
  jsonData += "\"gyro\":{\"x\":" + String(g.gyro.x, 2) + ",";
  jsonData += "\"y\":" + String(g.gyro.y, 2) + ",";
  jsonData += "\"z\":" + String(g.gyro.z, 2) + "}}}";
  
  // Print to Serial Monitor
  Serial.println(jsonData);

  // Send via BLE if device is connected
  if (deviceConnected) {
    pCharacteristic->setValue(jsonData.c_str());
    pCharacteristic->notify();
  }

  // Handle reconnection
  if (!deviceConnected && oldDeviceConnected) {
    delay(500); // give the bluetooth stack time to get ready
    pServer->startAdvertising(); // restart advertising
    Serial.println("Start advertising again");
    oldDeviceConnected = deviceConnected;
  }

  // Handle new connection
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }

  delay(50); 
}
